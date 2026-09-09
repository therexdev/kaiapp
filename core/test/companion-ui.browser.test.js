"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), { EventEmitter } = require("events");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("companion UI: Brain CRUD, API setup, workflow approval/recovery and responsive layouts", { skip: !fs.existsSync(CHROMIUM), timeout: 120000 }, async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"kai-companion-ui-"));
 const {createCore}=require("../server");const core=await createCore({dataDir:dir,port:0,onEvent:()=>{}});const base="http://127.0.0.1:"+await core.start();
 const key=crypto.randomBytes(32),iv=crypto.randomBytes(16);const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>{const c=crypto.createCipheriv("aes-256-cbc",key,iv);return Buffer.concat([c.update(s),c.final()]);},decryptString:b=>{const c=crypto.createDecipheriv("aes-256-cbc",key,iv);return Buffer.concat([c.update(b),c.final()]).toString();}};
 const {CompanionHub,registerCompanionIPC}=require("../../electron/companion-hub");const hub=new CompanionHub({dataDir:dir,safeStorage,privacyMode:()=>"local-first",models:()=>[{alias:"local-fixture",label:"Local fixture",status:"ready"}],canUseModel:()=>true,runLocal:async({prompt})=>"A useful project summary: "+prompt,fetchImpl:async()=>new Response('{"result":"Project is ready for review"}')});
 const handlers=new Map(),wc=new EventEmitter();wc.id=99;wc.mainFrame={url:base+"/"};wc.getURL=()=>base+"/";wc.isDestroyed=()=>false;const window=new EventEmitter();window.webContents=wc;window.isDestroyed=()=>false;window.isVisible=()=>true;
 const ipc=registerCompanionIPC({ipcMain:{handle:(c,f)=>handlers.set(c,f),removeHandler:c=>handlers.delete(c)},service:hub,origin:base,getMainWindow:()=>window,getMascotWindow:()=>null,dialog:{showMessageBox:async()=>({response:1})}});
 const {chromium}=require("playwright-core");const browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});t.after(async()=>{ipc.dispose();await browser.close();await core.stop();fs.rmSync(dir,{recursive:true,force:true});});
 const context=await browser.newContext({viewport:{width:1280,height:900}});
 await context.exposeFunction("fixtureCompanion",(channel,...args)=>handlers.get(channel)({sender:wc,senderFrame:wc.mainFrame},...args));
 await context.addInitScript(()=>{window.kaiCompanionBridge={manage:(a,p)=>window.fixtureCompanion("companion:manage",a,p),context:(m,q)=>window.fixtureCompanion("companion:context",m,q),tools:m=>window.fixtureCompanion("companion:tools",m),tool:(n,a,m)=>window.fixtureCompanion("companion:tool",n,a,m),cancel:()=>window.fixtureCompanion("companion:cancel")};});
 const page=await context.newPage(),errors=[];page.on("pageerror",e=>{errors.push(e.message);console.error(e.stack || e.message);});page.on("dialog",d=>d.accept(d.type()==="prompt"?"KAI companion":undefined));await page.goto(base);
 await page.click('[data-view="brain"]');await page.getByRole("button",{name:"Add memory",exact:true}).click();await page.getByLabel("Title",{exact:true}).fill("KAI project");await page.getByLabel("What should KAI know?").fill("Build an AI companion with useful memory, routines, and connections.");await page.getByLabel("Category").selectOption("projects");await page.getByLabel("Tags").fill("kai, companion");await page.getByRole("button",{name:"Save memory"}).click();await page.getByText("KAI project",{exact:true}).waitFor();
 await page.getByRole("button",{name:"Goals & tasks",exact:true}).click();await page.getByRole("button",{name:"Add a goal"}).click();await page.getByLabel("Goal",{exact:true}).fill("Make KAI helpful every day");await page.getByRole("button",{name:"Save goal"}).click();await page.getByText("Make KAI helpful every day",{exact:true}).waitFor();assert.equal(hub.store.data.goals.length,1);
 await page.click('[data-view="connections"]');await page.getByRole("button",{name:"Custom APIs",exact:true}).click();await page.getByRole("button",{name:"GitHub",exact:true}).click();await page.getByLabel("Your API token").fill("synthetic-ui-credential");await page.getByLabel("Let KAI use these operations").check();await page.getByLabel("Allow saved sources").check();await page.getByRole("button",{name:"Save connection"}).click();await page.getByRole("button",{name:"Open & test"}).click();await page.getByRole("button",{name:"Run request",exact:true}).click();await page.waitForFunction(()=>document.getElementById("connection-result")?.textContent.includes("ready for review"));assert.equal(hub.connections.list()[0].configured,true);
 await page.click('[data-view="workflows"]');await page.getByRole("button",{name:/Weekly goal review/}).click();await page.getByRole("button",{name:"Save workflow",exact:true}).click();await page.getByRole("button",{name:"Run",exact:true}).click();await page.getByLabel("Run input (optional)").fill("KAI companion");await page.getByRole("button",{name:"Start run",exact:true}).click();await page.waitForFunction(()=>document.querySelector('.hub-badge.waiting'));
 assert.equal(hub.store.data.notes.length,1);await page.getByRole("button",{name:"Review & resume"}).click();await page.waitForFunction(()=>document.querySelector('.hub-badge.completed'));assert.equal(hub.store.data.notes.length,2);
 hub.importText("Release journal", "KAI launch planning. Review the release milestones and follow up on testing.");
 await page.click('[data-view="brain"]');
 await page.locator('.hub-rail').getByRole("button", {name:"Awareness",exact:true}).click();
 await page.locator('input[name="mode"][value="assist"]').check();
 await page.getByLabel("My saved personal notes", {exact:true}).check();
 await page.getByLabel("My goals and priorities", {exact:true}).check();
 await page.getByRole("button", {name:"Save Awareness settings",exact:true}).click();
 await page.getByRole("button", {name:"Run now",exact:true}).click();
 await page.locator('.hub-rail').getByRole("button", {name:"Orchestration",exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.bn-job-list')?.textContent.includes("done"));
 assert.equal(hub.store.data.brain.awareness.mode,"assist");
 await page.locator('.hub-rail').getByRole("button", {name:"Goals & tasks",exact:true}).click();
 await page.getByRole("button",{name:"Add task",exact:true}).click();
 await page.locator("#bn-task-editor").getByLabel("Task",{exact:true}).fill("Review the Test installer");
 await page.getByRole("button",{name:"Save task",exact:true}).click();
 await page.getByRole("heading",{name:"Review the Test installer",exact:true}).waitFor();
 assert.equal(hub.store.data.brain.tasks.length,1);
 // Exercise the actual canvas: editable positions, ports, undo and typed config.
 await page.click('[data-view="workflows"]'); await page.getByRole("button",{name:"My workflows",exact:true}).click();
 await page.locator('[data-wf="new"]').click();
 await page.locator('[data-wf="add"][data-id="transform"]').click();
 await page.locator('[data-field="config.set"]').fill('{"result":"=item.text.toUpperCase()"}');
 await page.locator('[data-field="config.set"]').dispatchEvent("change");
 const added = await page.locator('.wf-node[data-node]:not([data-node="start"])').getAttribute("data-node");
 await page.locator('[data-wf="connectFrom"][data-id="start"]').evaluate(el=>el.click());
 await page.locator(`[data-wf="connectTo"][data-id="${added}"]`).evaluate(el=>el.click());
 assert.equal(await page.locator('.wf-edge').count(),1);
 await page.getByRole("button",{name:"Undo",exact:true}).click(); assert.equal(await page.locator('.wf-edge').count(),0);
 await page.getByRole("button",{name:"Redo",exact:true}).click(); assert.equal(await page.locator('.wf-edge').count(),1);
 await page.getByRole("button",{name:"Save workflow",exact:true}).click();
 await page.getByRole("button",{name:"Run",exact:true}).click(); await page.getByLabel("Run input (optional)").fill("hello"); await page.getByRole("button",{name:"Start run",exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.wf-run .hub-badge.completed'));
 assert.equal(hub.store.data.runs[0].output[0].result,"HELLO");
 const qa=process.env.KAI_MASCOT_QA_DIR;if(qa)fs.mkdirSync(qa,{recursive:true});
 for(const width of [1280,960,720]) {
  await page.setViewportSize({width,height:900});
  for(const view of ["brain","workflows","connections"]) {
   await page.click(`[data-view="${view}"]`);await page.locator(`#view-${view} .hub-content`).waitFor();
   const metrics=await page.locator(`#view-${view}`).evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert.ok(metrics.scroll<=metrics.width+2,view+" overflow at "+width+": "+JSON.stringify(metrics));
   if(qa)await page.screenshot({path:path.join(qa,`companion-${view}-${width}.png`),animations:"disabled"});
  }
  await page.click('[data-view="brain"]');
  for (const [key,label] of [["overview","Overview"],["map","Memory graph"],["notes","Memories"],["sources","Sources"],["sync","Sync & changes"],["awareness","Awareness"],["orchestration","Orchestration"]]) {
   await page.locator('.hub-rail').getByRole("button",{name:label,exact:true}).click();
   const bounds=await page.locator('#view-brain').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth})); assert.ok(bounds.scroll<=bounds.width+2,`Brain ${key} overflow at ${width}`);
   const nav=await page.locator('#view-brain .hub-rail').boundingBox(),pane=await page.locator('#view-brain .hub-content').boundingBox(); assert.ok(nav.x+nav.width<=pane.x,"navigation stays beside content");
   if(qa)await page.screenshot({path:path.join(qa,`brain-${key}-${width}.png`),animations:"disabled"});
  }
  await page.click('[data-view="workflows"]');await page.getByRole("button",{name:"My workflows",exact:true}).click();await page.locator('[data-wf="template"][data-id="review"]').click();await page.getByRole("button",{name:"Auto arrange",exact:true}).click();
  const canvas = await page.locator('.wf-viewport').boundingBox(), nodes = await page.locator('.wf-node').evaluateAll(els => els.map(el => {const r=el.getBoundingClientRect();return {id:el.dataset.node,x:r.x,y:r.y,width:r.width,height:r.height};}));
  for (const n of nodes) assert.ok(n.x>=canvas.x-2 && n.y>=canvas.y-2 && n.x+n.width<=canvas.x+canvas.width+2 && n.y+n.height<=canvas.y+canvas.height+2, "Fit includes node " + JSON.stringify({width,canvas,n}));
  assert.equal(new Set(nodes.map(n=>n.x+":"+n.y)).size,nodes.length,"auto-arranged nodes do not overlap");
  const fields=await page.locator('.wf-builder').first().evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));assert.ok(fields.scroll<=fields.width+2,"builder overflow "+width);if(qa)await page.screenshot({path:path.join(qa,`companion-builder-${width}.png`),animations:"disabled"});await page.getByRole("button",{name:"← Back",exact:true}).click();
 }
 await page.reload();await page.click('[data-view="brain"]');await page.getByRole("button",{name:"Memories",exact:true}).click();await page.getByText("KAI project",{exact:true}).waitFor();assert.deepEqual(errors,[]);
});
