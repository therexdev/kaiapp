"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("fs"),os=require("os"),path=require("path"),crypto=require("crypto"),{EventEmitter}=require("events");
const CHROMIUM=process.env.KAI_TEST_CHROMIUM||"/opt/pw-browsers/chromium";
test("Connections UI: catalog, two key modes, guided account sign-in, access selection and Brain collection",{skip:!fs.existsSync(CHROMIUM),timeout:120000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"kai-connections-ui-")),{fixture}=require("./fixtures/composio"),f=fixture();
 const {createCore}=require("../server"),core=await createCore({dataDir:dir,port:0,onEvent:()=>{}}),base="http://127.0.0.1:"+await core.start();
 const key=crypto.randomBytes(32),iv=crypto.randomBytes(16),safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>{const c=crypto.createCipheriv("aes-256-cbc",key,iv);return Buffer.concat([c.update(s),c.final()]);},decryptString:b=>{const c=crypto.createDecipheriv("aes-256-cbc",key,iv);return Buffer.concat([c.update(b),c.final()]).toString();}};
 let opened=0;const {CompanionHub,registerCompanionIPC}=require("../../electron/companion-hub"),hub=new CompanionHub({dataDir:dir,safeStorage,privacyMode:()=>"local-first",models:()=>[{alias:"local",status:"ready"}],canUseModel:()=>true,runLocal:async()=>"summary",fetchImpl:f.fetch,openExternal:async url=>{assert.match(url,/^https:\/\/connect.composio.dev\//);opened++;}});
 const handlers=new Map(),wc=new EventEmitter();wc.id=99;wc.mainFrame={url:base+"/"};wc.getURL=()=>base+"/";wc.isDestroyed=()=>false;const window=new EventEmitter();window.webContents=wc;window.isDestroyed=()=>false;window.isVisible=()=>true;
 const ipc=registerCompanionIPC({ipcMain:{handle:(c,fn)=>handlers.set(c,fn),removeHandler:c=>handlers.delete(c)},service:hub,origin:base,getMainWindow:()=>window,getMascotWindow:()=>null,dialog:{showMessageBox:async()=>({response:1})}});
 const {chromium}=require("playwright-core"),browser=await chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});t.after(async()=>{ipc.dispose();await browser.close();await core.stop();fs.rmSync(dir,{recursive:true,force:true});});
 const context=await browser.newContext({viewport:{width:1280,height:900}});await context.exposeFunction("fixtureCompanion",(channel,...args)=>handlers.get(channel)({sender:wc,senderFrame:wc.mainFrame},...args));
 await context.addInitScript(()=>{window.kaiCompanionBridge={manage:(a,p)=>window.fixtureCompanion("companion:manage",a,p),context:(m,q)=>window.fixtureCompanion("companion:context",m,q),tools:m=>window.fixtureCompanion("companion:tools",m),tool:(n,a,m)=>window.fixtureCompanion("companion:tool",n,a,m),cancel:()=>window.fixtureCompanion("companion:cancel")};});
 const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));await page.goto(base);await page.click('[data-view="connections"]');await page.locator('.cn-app-card').first().waitFor();
 const qa=process.env.KAI_MASCOT_QA_DIR;if(qa)fs.mkdirSync(qa,{recursive:true});
 for(const width of [1280,960,720]){await page.setViewportSize({width,height:900});const box=await page.locator('#view-connections').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert.ok(box.scroll<=box.width+2,"catalog overflow at "+width);assert.equal(await page.locator('.cn-app-card').count(),24);if(qa)await page.screenshot({path:path.join(qa,`connections-catalog-${width}.png`),animations:"disabled"});}
 await page.setViewportSize({width:1280,height:900});await page.locator('.hub-tabs').getByRole("button",{name:"Connection settings",exact:true}).click();await page.locator('input[name="mode"][value="personal"]').check();await page.getByLabel("Composio project API key",{exact:true}).fill(f.key);if(qa)await page.screenshot({path:path.join(qa,"connections-setup-1280.png"),animations:"disabled"});await page.getByRole("button",{name:"Save connection method",exact:true}).click();await page.locator('[data-cn="app"][data-value="github"]').waitFor();
 await page.getByLabel("Search apps",{exact:true}).fill("GitHub");await page.waitForFunction(()=>document.querySelectorAll('.cn-app-card').length===1);await page.locator('[data-cn="app"][data-value="github"]').click();await page.getByRole("button",{name:"Connect GitHub",exact:true}).click();await page.getByRole("heading",{name:"Finish connecting",exact:true}).waitFor();assert.equal(opened,1);f.authorize();await page.getByRole("button",{name:"Check connection",exact:true}).click();await page.getByLabel("Account name",{exact:true}).waitFor();await page.getByLabel("Account name",{exact:true}).fill("My work GitHub");await page.getByLabel("Allow Brain and workflow reads",{exact:false}).check();await page.locator('[data-cn-tool="GITHUB_LIST_ISSUES"]').check();assert.equal(await page.locator('[data-cn-tool="GITHUB_CREATE_ISSUE"]').isDisabled(),true);
 for(const width of [1280,720]){await page.setViewportSize({width,height:900});const box=await page.locator('.cn-drawer').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));assert.ok(box.scroll<=box.width+2,"access overflow");if(qa)await page.screenshot({path:path.join(qa,`connections-access-${width}.png`),animations:"disabled"});}
 await page.getByRole("button",{name:"Save access",exact:true}).click();await page.getByRole("button",{name:"Collect into Brain",exact:true}).click();await page.getByLabel("Repository owner",{exact:false}).fill("therexdev");await page.getByLabel("Repository name",{exact:false}).fill("kaiapp");await page.getByLabel("Keep this source up to date",{exact:false}).check();if(qa)await page.screenshot({path:path.join(qa,"connections-collect-720.png"),animations:"disabled"});await page.getByRole("button",{name:"Add to Brain",exact:true}).click();await page.getByRole("button",{name:"Refresh this source",exact:true}).waitFor();assert.equal(hub.store.data.sources.length,1);assert.match(hub.store.context("KAI"),/Plan KAI companion/);assert.equal(f.executions[0].arguments.repo,"kaiapp");await page.getByRole("button",{name:"Refresh this source",exact:true}).click();assert.equal(hub.store.data.sources.length,1);await page.keyboard.press("Escape");await page.locator('.hub-tabs').getByRole("button",{name:"Connection settings",exact:true}).click();await page.locator('input[name="mode"][value="managed"]').check();await page.getByRole("button",{name:"Save connection method",exact:true}).click();await page.locator('.cn-app-card').first().waitFor();await page.locator('.hub-tabs').getByRole("button",{name:"Connected",exact:true}).click();await page.getByRole("heading",{name:"A little more connected.",exact:true}).waitFor();assert.equal(hub.connections.list().length,0);assert.deepEqual(errors,[]);
});

test("Connections readiness: managed sign-in, delayed enablement, refresh errors and Local-Only stay with the selected app", { skip: !fs.existsSync(CHROMIUM), timeout: 120000 }, async t => {
 const { CompanionHub } = require("../../electron/companion-hub"), { ComposioClient } = require("../lib/composio-client"), { fixture } = require("./fixtures/composio");
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-readiness-ui-")), f = fixture(), api = new ComposioClient({ key: f.key, fetchImpl: f.fetch });
 let token = "", available = true, privacy = "local-first", accountsStatus = 200, statusGate = null, statusCalls = 0, opened = 0;
 const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
 const hub = new CompanionHub({ dataDir: dir, safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() },
  account: { origin: () => "https://kai.example", _token: () => token }, privacyMode: () => privacy, models: () => [],
  fetchImpl: async (url, init = {}) => {
   if (url === "https://kai.example/connections/status") { statusCalls++; await statusGate; return response({ available, protocol: 1, generation: "managed-project" }); }
   const action = url.split("/").at(-1), input = init.body ? JSON.parse(init.body) : {};
   assert.equal(init.headers.authorization, "Bearer " + token);
   if (action === "accounts") return response({ ok: accountsStatus === 200, error: "Account refresh temporarily failed.", result: { userId: "kai:alice", accounts: await api.accounts("kai:alice") } }, accountsStatus);
   if (action === "catalog") return response({ ok: true, result: await api.catalog(input) });
   if (action === "connect") return response({ ok: true, result: await api.connect(input.slug, "kai:alice") });
   throw new Error("Unexpected managed action: " + action);
  }, openExternal: async () => { opened++; } });
 const { chromium } = require("playwright-core"), browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
 t.after(async () => { hub.stop(); await browser.close(); fs.rmSync(dir, { recursive: true, force: true }); });
 const page = await browser.newPage({ viewport: { width: 720, height: 900 } }), errors = [];
 page.on("pageerror", e => errors.push(e.message));
 await page.exposeFunction("connectionManage", async (action, input) => {
  if (action === "status") return hub.status();
  if (action === "composioRefresh") return hub.composio.refresh();
  if (action === "composioCatalog") return hub.composio.catalog(input);
  if (action === "composioConnect") return hub.composio.connect(input.slug);
  throw new Error("Unexpected UI action: " + action);
 });
 await page.setContent('<main id="connections"></main>');
 await page.addStyleTag({ path: path.resolve(__dirname, "../../ui/styles.css") });
 await page.addScriptTag({ path: path.resolve(__dirname, "../../ui/connections.js") });
 const render = async (section = "explore") => page.evaluate(async section => {
  window.navigated = []; window.activateView = view => window.navigated.push(view);
  const host = document.createElement("div"); document.getElementById("connections").replaceChildren(host);
  window.KaiConnections.render(host, { section, state: await window.connectionManage("status"), manage: window.connectionManage, navigate: next => window.navigated.push(next) });
 }, section);
 const app = () => page.locator('[data-cn="app"][data-value="github"]');
 const dialog = () => page.getByRole("dialog", { name: "GitHub", exact: true });
 const waitText = async text => page.waitForFunction(text => document.getElementById("connections").textContent.includes(text), text);
 const waitIdle = async () => page.waitForFunction(() => !document.querySelector('#connections [data-cn]:disabled'));

 await render(); await waitText("Sign in to KAI to connect apps");
 await app().click(); await dialog().getByRole("button", { name: "Sign in to KAI", exact: true }).waitFor();
 assert.deepEqual(await page.evaluate(() => window.navigated), [], "Connect must not send a signed-out user silently to setup");
 assert.equal(opened, 0);
 const qa = process.env.KAI_MASCOT_QA_DIR;
 if (qa) { fs.mkdirSync(qa, { recursive: true }); await page.screenshot({ path: path.join(qa, "connections-signin-720.png"), animations: "disabled" }); }
 await dialog().getByRole("button", { name: "Sign in to KAI", exact: true }).click();
 assert.deepEqual(await page.evaluate(() => window.navigated), ["settings"]);

 token = "session-a"; hub.composio.managed = { available: false };
 let release; statusGate = new Promise(resolve => { release = resolve; });
 const before = statusCalls;
 await render(); await app().click(); await dialog().getByText("KAI-managed connections are not enabled", { exact: true }).waitFor();
 assert.equal(statusCalls, before + 1, "the card and initial load share one status request");
 await dialog().getByRole("button", { name: "Close", exact: true }).click();
 assert.equal(await dialog().count(), 0, "Close remains available during a slow refresh");
 release(); statusGate = null; await waitIdle();
 await app().click(); await dialog().getByRole("button", { name: "Connect GitHub", exact: true }).waitFor();
 await dialog().getByRole("button", { name: "Connect GitHub", exact: true }).click();
 await page.getByRole("heading", { name: "Finish connecting", exact: true }).waitFor();
 assert.equal(opened, 1); assert.deepEqual(await page.evaluate(() => window.navigated), []);

 hub.composio.managed = null; accountsStatus = 503;
 await render(); await waitText("Account refresh temporarily failed.");
 await app().click(); await dialog().getByRole("button", { name: "Connect GitHub", exact: true }).waitFor();
 assert.deepEqual(await page.evaluate(() => window.navigated), [], "a failed account refresh must retain the newly fetched server status");

 accountsStatus = 401; await render(); await waitText("Sign in to KAI again"); await app().click();
 await dialog().getByRole("button", { name: "Sign in to KAI", exact: true }).waitFor(); await waitIdle();
 assert.equal(opened, 1); assert.equal(hub.status().composio.managedAvailable, true);

 privacy = "local-only"; const calls = statusCalls;
 await render(); await app().click(); await dialog().getByRole("button", { name: "Open privacy settings", exact: true }).waitFor();
 assert.equal(statusCalls, calls); assert.equal(opened, 1);

 privacy = "local-first"; accountsStatus = 200; token = "session-b";
 statusGate = new Promise(resolve => { release = resolve; });
 await render("setup"); await page.locator('input[name="mode"][value="personal"]').check();
 await page.getByLabel("Composio project API key", { exact: true }).fill("synthetic-unsaved-key");
 release(); statusGate = null; await waitText("Available · KAI account signed in");
 assert.equal(await page.locator('input[name="mode"][value="personal"]').isChecked(), true);
 assert.equal(await page.getByLabel("Composio project API key", { exact: true }).inputValue(), "synthetic-unsaved-key");
 assert.deepEqual(errors, []);
});
