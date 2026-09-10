"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), { EventEmitter } = require("events");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("connected chat: main Chat and desktop KAI execute a long chain and render safe receipts", { skip: !fs.existsSync(CHROMIUM), timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-connected-ui-"));
  fs.mkdirSync(path.join(dir, "models")); fs.writeFileSync(path.join(dir,"models","smollm2-135m-instruct-q8_0.gguf"), "weights");
  const core = await require("../server").createCore({ dataDir: dir, port: 0, llamaBin: path.join(__dirname,"fixtures/fake-llama-server"), onEvent:()=>{} });
  const origin = "http://127.0.0.1:" + await core.start();
  const { CompanionHub, registerCompanionIPC } = require("../../electron/companion-hub");
  const sent = [], reviewed = [];
  const hub = new CompanionHub({ dataDir:dir, safeStorage:{ isEncryptionAvailable:()=>true, encryptString:s=>Buffer.from(s).reverse(), decryptString:b=>Buffer.from(b).reverse().toString() }, models:()=>[], canUseModel:()=>true, privacyMode:()=>"local-first", runLocal:async()=>"unused", fetchImpl:async(_u, init)=>{ const body=JSON.parse(init.body || "{}"); sent.push(body); return new Response(JSON.stringify({ id:"object-"+sent.length, url:"https://example.com/result/"+sent.length, body })); } });
  const c = hub.connections.save({ name:"Directory account",baseUrl:"https://example.com",auth:"none",allowAgent:true,operations:[{id:"create",name:"Create object",method:"POST",path:"/objects"}] });
  const handlers = new Map(), windows = ["/","/mascot.html"].map((route,i)=>{ const wc = new EventEmitter(); wc.id=i+1; wc.mainFrame={url:origin+route}; wc.getURL=()=>origin+route; wc.isDestroyed=()=>false; const w=new EventEmitter();w.webContents=wc;w.isDestroyed=()=>false;w.isVisible=()=>true;return w; });
  const ipc = registerCompanionIPC({ ipcMain:{handle:(n,f)=>handlers.set(n,f),removeHandler:n=>handlers.delete(n)},service:hub,origin,getMainWindow:()=>windows[0],getMascotWindow:()=>windows[1],dialog:{showMessageBox:async(_w,input)=>{reviewed.push(input);return {response:1};}} });
  const browser = await require("playwright-core").chromium.launch({executablePath:CHROMIUM,args:["--no-sandbox"]});
  t.after(async()=>{ipc.dispose();await browser.close();await core.stop();fs.rmSync(dir,{recursive:true,force:true});});
  for (const [i, route] of ["/","/mascot.html"].entries()) {
    const page = await browser.newPage({viewport:{width:i?660:1280,height:900}}), errors=[];
    page.on("pageerror",e=>errors.push(e.message));
    await page.exposeFunction("fixtureIPC",(channel,...args)=>handlers.get(channel)({sender:windows[i].webContents,senderFrame:windows[i].webContents.mainFrame},...args));
    await page.addInitScript(()=>{
      window.kaiCompanionBridge={context:(m,q)=>window.fixtureIPC("companion:context",m,q),tools:m=>window.fixtureIPC("companion:tools",m),tool:(n,a,m,s)=>window.fixtureIPC("companion:tool",n,a,m,s),session:(o,v)=>window.fixtureIPC("companion:session",o,v),activity:(m,c)=>window.fixtureIPC("companion:activity",m,c),cancel:()=>window.fixtureIPC("companion:cancel"),manage:(a,p)=>window.fixtureIPC("companion:manage",a,p)};
      window.kaiDesktop={regions(){},startDrag(){},endDrag(){},expand:async value=>{window.__event?.({type:"expanded",value});return{expanded:value};},onEvent:cb=>window.__event=cb};
    });
    const base = sent.length;
    const actions = [
      {tool:"connected_find",args:{query:"Directory"}},
      {tool:"connected_actions",args:{connectionId:c.id,query:"create"}},
      {tool:"connected_describe",args:{connectionId:c.id,operationId:"create"}},
      {tool:"connected_call",args:{connectionId:c.id,operationId:"create",body:{name:"Dentists "+i}}},
      {tool:"connected_history",args:{}},
      {tool:"connected_call",args:{connectionId:c.id,operationId:"create",body:{name:"Sheet",parent:"object-"+(base+1)}}},
      {tool:"connected_history",args:{}},
      {tool:"connected_call",args:{connectionId:c.id,operationId:"create",body:{recipient:"verified-person",link:"https://example.com/result/"+(base+2)}}},
      {answer:true},
    ]; let planning=0;
    await page.route("**/core/chat/completions",async r=>{
      const body=r.request().postDataJSON();
      if (body.stream===false) return r.fulfill({status:200,contentType:"application/json",body:JSON.stringify({choices:[{message:{content:JSON.stringify(actions[planning++] || {answer:true})}}]})});
      return r.fulfill({status:200,contentType:"text/event-stream",body:'data: '+JSON.stringify({choices:[{delta:{content:"The folder and spreadsheet were created and the message was accepted."}}]})+'\n\ndata: [DONE]\n\n'});
    });
    await page.goto(origin+route);
    if (i) { await page.waitForFunction(()=>document.querySelector("#model").value); await page.click("#toggle-chat"); await page.fill("#question","Create a folder and spreadsheet, then message the link to the verified person."); await page.locator("#question").press("Enter"); }
    else { await page.waitForFunction(()=>document.querySelector("#model-pick").value); await page.fill("#input","Create a folder and spreadsheet, then message the link to the verified person."); await page.click("#btn-send"); }
    try { await page.waitForFunction(()=>[...document.querySelectorAll(".kai-action-results summary")].some(x=>x.textContent.includes("3"))); }
    catch (e) { console.error(JSON.stringify({ surface:i, planning, sent:sent.slice(base), errors, text:await page.locator("body").innerText() })); throw e; }
    await page.waitForFunction(()=>document.body.textContent.includes("message was accepted."));
    assert.equal(sent.length,base+3); assert.ok(planning>6,"the requested chain exceeds the old six-step limit");
    await page.locator(".kai-action-results summary").first().click();
    const links = await page.locator('.kai-action-results a[href^="https://example.com/result/"]').evaluateAll(nodes => nodes.map(n => n.href));
    assert.deepEqual([...new Set(links)].sort(), [1,2,3].map(n => "https://example.com/result/" + (base+n)).sort());
    for (const width of i?[660,460]:[1280,720]) { await page.setViewportSize({width,height:900}); const box=await page.locator(".kai-action-results").evaluate(el=>({w:el.clientWidth,s:el.scrollWidth}));assert.ok(box.s<=box.w+2,"receipt overflow"); if(process.env.KAI_MASCOT_QA_DIR){fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.KAI_MASCOT_QA_DIR,`connected-${i}-${width}.png`)});} }
    assert.deepEqual(errors,[]); await page.close();
  }
  assert.equal(reviewed.length,6);
});
