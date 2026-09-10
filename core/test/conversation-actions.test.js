"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { CompanionHub, registerCompanionIPC } = require("../../electron/companion-hub");
const { reference } = require("../../electron/conversation-actions");
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-actions-"));
  const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).reverse(), decryptString: b => Buffer.from(b).reverse().toString() };
  let mode = "local-first", count = 0;
  const hub = new CompanionHub({ dataDir: dir, safeStorage: storage, privacyMode: () => mode, models: () => [{ alias: "local", status: "ready" }], canUseModel: m => m === "local" || m === "desktop:fixture", runLocal: async () => "done", fetchImpl: async (url, options) => { count++; return new Response(JSON.stringify({ id: "object-" + count, url: "https://fixture.example/result/" + count, body: options.body ? JSON.parse(options.body) : null })); }, ...overrides });
  const c = hub.connections.save({ name: "Fixture account", baseUrl: "https://fixture.example", auth: "none", enabled: true, allowAgent: true, operations: [{ id: "create", name: "Create object", method: "POST", path: "/items" }, { id: "read", name: "Read object", method: "GET", path: "/items/{item}" }] });
  t.after(() => { hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const turn = hub.actions.begin(10, "local", { question: "Create my folder and sheet", conversationId: "chat-one" });
  const call = (name, args, confirm = async () => true, signal = new AbortController().signal) => hub.actions.tool(10, turn.id, name, args, "local", confirm, signal);
  return { hub, c, turn, call, dir, storage, count: () => count, privacy: x => mode = x };
}
test("account discovery is bounded, schemas are selected, disabled and wrong-window access fail closed", async t => {
  const f = fixture(t);
  assert.equal((await f.call("connected_find", { query: "Fixture" })).accounts[0].id, f.c.id);
  assert.equal((await f.call("connected_describe", { connectionId: f.c.id, operationId: "create" })).action.id, "create");
  await assert.rejects(f.hub.actions.tool(11, f.turn.id, "connected_find", {}, "local", async()=>true, new AbortController().signal), /attended/);
  await assert.rejects(f.call("connected_describe", { connectionId: f.c.id, operationId: "unselected" }), /Select/);
  f.hub.store.change(d => { d.connections[0].allowAgent = false; });
  await assert.rejects(f.call("connected_call", { connectionId: f.c.id, operationId: "create" }), /Use in conversations/);
  assert.equal(f.count(), 0);
});
test("folder → sheet → message passes actual result IDs and retains receipts; exact writes do not repeat", async t => {
  const f = fixture(t), input = { operation: "run", name: "Folder and sheet", steps: [
    { id: "folder", connectionId: f.c.id, operationId: "create", body: { name: "Dentists" } },
    { id: "sheet", connectionId: f.c.id, operationId: "create", body: { parent: { $ref: "folder.data.id" }, name: "Directory" } },
    { id: "message", connectionId: f.c.id, operationId: "create", body: { recipient: "verified-user-id", link: { $ref: "sheet.data.url" } } },
  ] };
  const result = await f.call("instant_workflow", input);
  assert.equal(result.steps.sheet.data.body.parent, "object-1");
  assert.equal(result.steps.message.data.body.link, "https://fixture.example/result/2");
  assert.equal(f.count(), 3);
  await f.call("connected_call", { connectionId: f.c.id, operationId: "create", body: { name: "Dentists" } });
  assert.equal(f.count(), 3);
  assert.equal(f.hub.actions.view(f.turn.id).actions.length, 3);
  assert.ok(!fs.readFileSync(path.join(f.dir, "companion-hub.json"), "utf8").includes("Directory"));
});
test("read-after-write fetches fresh data; it does not reuse a stale read receipt", async t => {
  const f = fixture(t), read = { connectionId: f.c.id, operationId: "read", arguments: { item: "one" } };
  await f.call("connected_call", read);
  await f.call("connected_call", { connectionId: f.c.id, operationId: "create", body: { name: "changed" } });
  const result = await f.call("connected_call", read); assert.equal(f.count(), 3); assert.equal(result.data.id, "object-3");
});
test("approval decline, changed connection, Local-Only and cancellation cause no dispatch", async t => {
  for (const kind of ["decline", "revision", "privacy", "cancel"]) {
    const f = fixture(t), controller = new AbortController();
    await assert.rejects(f.call("connected_call", { connectionId: f.c.id, operationId: "create", body: { kind } }, async () => {
      if (kind === "revision") f.hub.store.change(d => { d.connections[0].revision++; });
      if (kind === "privacy") f.privacy("local-only");
      if (kind === "cancel") controller.abort();
      return kind !== "decline";
    }, controller.signal)); assert.equal(f.count(), 0);
  }
});
test("uncertain writes are journaled, block retries across turns and keep partial objects", async t => {
  let n = 0; const f = fixture(t, { fetchImpl: async () => { if (++n === 2) throw Error("Lost response after write"); return new Response('{"id":"created-folder"}'); } });
  const args = { connectionId: f.c.id, operationId: "create", body: { name: "sheet" } };
  await f.call("connected_call", { ...args, body: { name: "folder" } });
  await assert.rejects(f.call("connected_call", args));
  assert.deepEqual(f.hub.actions.view(f.turn.id).actions.map(x => x.status), ["returned", "uncertain"]);
  const next = f.hub.actions.begin(10, "local", { question: "continue", conversationId: "chat-one" });
  f.hub.store.change(d => { d.connections[0].revision++; });
  await assert.rejects(f.hub.actions.tool(10, next.id, "connected_call", args, "local", async()=>true, new AbortController().signal), /uncertain/);
  assert.equal(n, 2);
});
test("references reject prototype access, missing outputs and forward dependencies before side effects", async t => {
  const f = fixture(t); assert.throws(() => reference("x.constructor", { x: {} }), /Missing/);
  await assert.rejects(f.call("instant_workflow", { operation: "run", name: "bad", steps: [{ id: "first", connectionId: f.c.id, operationId: "create", body: { parent: { $ref: "later.data.id" } } }] }), /earlier/);
  assert.equal(f.count(), 0);
});
test("saved instant workflows stay disabled and literal formula-like source text cannot become code", async t => {
  const f = fixture(t), result = await f.call("instant_workflow", { operation: "save", name: "Saved plan", steps: [{ id: "create", connectionId: f.c.id, operationId: "create", body: { text: "=untrusted()" } }] });
  const saved = f.hub.store.data.workflows.find(w => w.id === result.id);
  assert.equal(saved.draft, true); assert.equal(saved.enabled, false);
  assert.equal(saved.graph.nodes[1].config.body.text, '="=untrusted()"');
  assert.equal(f.count(), 0);
});
test("saved workflows can be found, inspected and run without enabling schedules; drafts are refused", async t => {
  const f = fixture(t), w = f.hub.workflows.save({ name: "Daily Brief", steps: [{ type: "output", text: "hello" }] });
  const found = await f.call("workflow_control", { operation: "find", query: "daily" }); assert.equal(found[0].id, w.id);
  await assert.rejects(f.call("workflow_control", { operation: "run", id: w.id, revision: -1 }), /revision/);
  const started = await f.call("workflow_control", { operation: "run", id: w.id, revision: w.revision });
  assert.ok(started.id); assert.equal(f.hub.store.data.workflows[0].enabled, false);
  const draft = f.hub.workflows.save({ name: "Unreviewed", steps: [{ type: "output" }] }, { draft: true });
  await assert.rejects(f.call("workflow_control", { operation: "run", id: draft.id, revision: draft.revision }), /Review/);
});
test("public research after private observations uses only reviewed query/URL with no Core or private transcript", async t => {
  const calls = []; const f = fixture(t, { fetchImpl: async (url, init) => { calls.push(String(url)); assert.ok(!JSON.stringify(init).includes("SECRET_BRAIN")); return new Response('<html><title>Practice</title><p>Public dentist address</p></html>', { headers: { "content-type": "text/html" } }); }, lookup: async()=>[{address:"93.184.216.34",family:4}] });
  f.hub.store.note({ text: "SECRET_BRAIN" });
  const r = await f.call("connected_research", { operation: "read", url: "https://fixture.example/practice" }, async (_name, details) => { assert.equal(details.url, "https://fixture.example/practice"); return true; });
  assert.match(r.text, /dentist/); assert.equal(calls.length, 1);
  await assert.rejects(f.call("connected_research", { operation: "read", url: "http://127.0.0.1/private" }));
  assert.equal(calls.length, 1);
});

test("major connector action schemas execute through both personal and managed Composio with identical permissions", async t => {
  const { ComposioClient } = require("../lib/composio-client");
  const samples = [
    ["googlecalendar","GOOGLECALENDAR_CREATE_EVENT",{summary:"Dentist",start_datetime:"2026-09-11T08:00:00-05:00"}],
    ["googledocs","GOOGLEDOCS_CREATE_DOCUMENT",{title:"Research"}],
    ["googlesheets","GOOGLESHEETS_CREATE_GOOGLE_SHEET1",{title:"Directory"}],
    ["googledrive","GOOGLEDRIVE_CREATE_FOLDER",{name:"Dentists"}],
    ["discordbot","DISCORDBOT_CREATE_MESSAGE",{channel_id:"verified-dm-channel",content:"Ready"}],
    ["slack","SLACK_CHAT_POST_MESSAGE",{channel:"verified-channel",text:"Ready"}],
    ["gmail","GMAIL_SEND_EMAIL",{recipient_email:"fixture@example.com",body:"Ready"}],
    ["microsoft_teams","MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE",{chat_id:"verified-chat",content:"Ready"}],
    ["notion","NOTION_CREATE_NOTION_PAGE",{parent_id:"verified-parent",title:"Research"}],
    ["github","GITHUB_CREATE_AN_ISSUE",{owner:"fixture",repo:"project",title:"Follow-up"}],
    ["todoist","TODOIST_CREATE_TASK",{content:"Follow up",project_id:"verified-project"}],
    ["one_drive","ONE_DRIVE_ONEDRIVE_CREATE_FOLDER",{name:"Research"}],
    ["excel","EXCEL_CREATE_WORKBOOK",{name:"Directory"}],
  ];
  // Synthetic schemas test transport/permission parity, not real provider field compatibility.
  for (const mode of ["personal","managed"]) for (const [toolkit,tool,args] of samples) {
    let executions=0; const key="fixture-composio-key", user="fixture-user";
    const metadata={slug:tool,name:tool,toolkit:{slug:toolkit},version:"20260910_00",input_parameters:{type:"object",properties:Object.fromEntries(Object.keys(args).map(k=>[k,{type:"string"}])),required:Object.keys(args)}};
    const account={id:"ca_fixture",user_id:user,toolkit:{slug:toolkit},status:"ACTIVE"};
    const upstream=async(url,init)=>{const p=new URL(url).pathname;if(p.includes("/connected_accounts/"))return new Response(JSON.stringify(account));if(p.includes("/tools/execute/")){executions++;assert.deepEqual(JSON.parse(init.body).arguments,args);return new Response(JSON.stringify({successful:true,data:{id:"provider-object",url:"https://example.com/object"}}));}if(p.includes("/tools/"))return new Response(JSON.stringify(metadata));throw Error("Unexpected request");};
    const client=new ComposioClient({key,fetchImpl:upstream});
    const f=fixture(t,{account:{origin:()=>"https://kai.example",_token:()=>"session-fixture"},fetchImpl:async(url,init)=>{
      if(new URL(url).origin!=="https://kai.example")return upstream(url,init);
      assert.equal(init.headers.authorization,"Bearer session-fixture");const body=JSON.parse(init.body);assert.equal(body.generation,"fixture-generation");
      const result=url.endsWith("/tool")?await client.tool(body.slug,body.version):await client.execute(body,user);
      return new Response(JSON.stringify({ok:true,result}));
    }});
    f.hub.store.change(d=>{d.composio={mode,key,userId:user};});f.hub.composio.managed={available:true,generation:"fixture-generation"};
    const ctx=f.hub.composio.context();
    f.hub.store.change(d=>{d.connections.push({id:"account",provider:"composio",toolkit,accountId:"ca_fixture",name:toolkit,mode,project:ctx.project,binding:ctx.binding,userId:user,status:"ACTIVE",enabled:true,allowAgent:false,allowWrite:false,operations:[],revision:1});});
    await f.hub.composio.permissions({id:"account",allowAgent:true,allowWrite:true,tools:[tool]});
    const schema=await f.call("connected_describe",{connectionId:"account",operationId:tool});assert.deepEqual(Object.keys(schema.action.schema.properties),Object.keys(args));
    await assert.rejects(f.call("connected_call",{connectionId:"account",operationId:tool,arguments:{...args,unrecognized:"bad"}}),/Unknown input/);
    const result=await f.call("connected_call",{connectionId:"account",operationId:tool,arguments:args});assert.equal(result.data.id,"provider-object");assert.equal(executions,1);
  }
});

test("main and mascot runtimes retain the attended bridge through an eight-action chain and finish it", async t => {
  const vm = require("vm"), Agents = require("../../ui/agents"), Mascot = require("../../ui/mascot-tools");
  for (const surface of ["main","mascot"]) {
    const f = fixture(t); let session, finished=0, plans=0;
    const checked = async run => { try { return { ok:true, result:await run() }; } catch(e) { return {ok:false,error:e.message}; } };
    const bridge = { tools:async()=>({ok:true,result:f.hub.toolList("local")}),
      session:async(op, input)=>checked(()=>{if(op==="begin"){session=f.hub.actions.begin(12,input.model,input);return session;}if(op==="status")return f.hub.actions.view(input.id);if(op==="finish"){finished++;return f.hub.actions.finish(12,input.id);}}),
      tool:async(n,a,m,s)=>checked(()=>f.hub.tool(n,a,m,async()=>true,new AbortController().signal,{owner:12,id:s})),cancel:async()=>({ok:true}) };
    const window={kaiCompanionBridge:bridge};vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../../ui/companion-client.js"),"utf8"),{window,DOMException,setInterval,clearInterval});
    const question="Make eight objects in my Google Drive";
    const json=window.KaiCompanionClient.toolJSON("local",async()=>({tools:[]}),new AbortController().signal,{question,conversationId:"runtime-"+surface});
    const ask=async()=> { const n=plans++; return JSON.stringify(n>=16 ? {answer:true} : n%2 ? {tool:"connected_history",args:{}} : {tool:"connected_call",args:{connectionId:f.c.id,operationId:"create",body:{name:"item-"+n}}}); };
    if(surface==="main")await Agents.makeRuntime({json,askModelOnce:ask}).runAgent("Make eight objects","local");
    else await Mascot.run({question,json,askModel:ask,contextSize:16000});
    assert.equal(f.count(),8);assert.equal(finished,1);assert.equal(f.hub.actions.turn(session.id).status,"finished");
  }
});

test("attended session is revoked on hide and cannot be resumed by a different frame/window", async t => {
  const {EventEmitter}=require("events"),f=fixture(t),handlers=new Map();
  const wc=new EventEmitter();wc.id=50;wc.mainFrame={url:"http://127.0.0.1:41100/"};wc.getURL=()=>wc.mainFrame.url;wc.isDestroyed=()=>false;
  const win=new EventEmitter();win.webContents=wc;win.isDestroyed=()=>false;win.isVisible=()=>true;
  const ipc=registerCompanionIPC({ipcMain:{handle:(n,h)=>handlers.set(n,h),removeHandler:n=>handlers.delete(n)},service:f.hub,origin:"http://127.0.0.1:41100",getMainWindow:()=>win,getMascotWindow:()=>null,dialog:{showMessageBox:async()=>({response:1})}});t.after(()=>ipc.dispose());
  const event={sender:wc,senderFrame:wc.mainFrame};
  const s=await handlers.get("companion:session")(event,"begin",{model:"local",question:"Create",conversationId:"ui"});assert.equal(s.ok,true);
  await assert.rejects(handlers.get("companion:session")({...event,senderFrame:{url:wc.mainFrame.url}},"begin",{model:"local",question:"bad"}),/denied/);
  win.emit("hide");const r=await handlers.get("companion:tool")(event,"connected_call",{connectionId:f.c.id,operationId:"create"},"local",s.result.id);assert.equal(r.ok,false);assert.equal(f.count(),0);
});

test("retention caps keep old uncertain receipts so a later request cannot silently repeat them", async t => {
  const f=fixture(t);f.hub.store.change(d=>{d.conversations=[...Array.from({length:99},(_,i)=>({id:"ordinary-"+i,conversationId:"other",question:"old",model:"local",at:Date.now(),status:"finished",actions:[],plans:[]})),{id:"uncertain-old",conversationId:"other",question:"create",model:"local",at:1,status:"interrupted",actions:[{id:"lost",status:"uncertain",write:true}],plans:[]},...d.conversations];});
  f.hub.actions.begin(21,"local",{question:"New request",conversationId:"new"});
  assert.ok(f.hub.store.data.conversations.some(t=>t.id==="uncertain-old"));assert.equal(f.hub.store.data.conversations.length,100);
});
