"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), os = require("os");
const { startMascotServer } = require("./fixtures/mascot-server");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("Desktop UI opens Tubi directly, uses private screen plans, stays compact and stops late actions", { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-computer-ui-")), fixture = await startMascotServer(dir);
  const browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 660, height: 560 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-mascot-voice", "0");
    window.__desktopCalls = []; window.__openedSites = []; window.__ended = 0;
    window.kaiDesktop = { regions() {}, onEvent: fn => { window.__kaiEvent = fn; },
      expand: async value => { window.__kaiEvent({ type: "expanded", value }); },
      computerStatus: async () => ({ available: true }), openWebsite: async text => { window.__openedSites.push(text); return { message: "Opened Tubi in your default browser." }; },
      computerBegin: async request => { window.__request = request; window.__kaiEvent({ type: "computer", value: { active: true } }); return { id: "scope" }; },
      computerCall: async (id, name, args) => {
        window.__desktopCalls.push({ id, name, args });
        if (window.__hold) await new Promise(resolve => { window.__resolveView = resolve; });
        return { summary: name === "computer_look" ? "Inspected the window." : "Clicked Play; verify the player.", screen: { frame: "f" + window.__desktopCalls.length, window: { title: "Movies" }, image: "data:image/png;base64,PRIVATE_PIXELS", elements: [{ id: "e1", name: name === "computer_look" ? "Play" : "Playing Arrival", enabled: true }] } };
      }, computerEnd: async () => { window.__ended++; window.__kaiEvent({ type: "computer", value: { active: false } }); },
      cancelAction: () => { window.__cancelled = true; window.__resolveView?.(); } };
  });
  await page.goto(fixture.origin + "/mascot.html"); await page.waitForFunction(() => document.querySelector("#model").value === "tiny-live");
  await page.click("#toggle-chat"); await page.fill("#question", "Open Tubi"); await page.press("#question", "Enter");
  await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("Opened Tubi") && document.querySelector("#send").hidden === false);
  assert.deepEqual(await page.evaluate(() => window.__openedSites), ["Open Tubi"]);
  assert.equal(fixture.state.requests.length, 0); assert.equal(fixture.state.plans?.length || 0, 0);
  fixture.state.reply = "The player shows Playing Arrival.";
  fixture.state.actions = [{ tool: "computer_click", args: { frame: "f1", element: "e1" } }, { answer: true }];
  await page.fill("#question", "Play the movie on my screen"); await page.press("#question", "Enter");
  await page.click("#collapse");
  await page.waitForFunction(() => window.__desktopCalls.length === 2 && document.querySelector("#send").hidden === false);
  assert.equal(await page.isHidden("#conversation"), true);
  assert.equal(fixture.state.toolCalls?.length || 0, 0, "Desktop tools never call public Core tools");
  assert.ok(fixture.state.plans.every(p => p.kai_private_desktop === true));
  assert.ok(fixture.state.plans.some(p => JSON.stringify(p.messages).includes("PRIVATE_PIXELS")));
  assert.equal(fixture.state.requests[0].kai_private_desktop, true);
  assert.doesNotMatch(JSON.stringify(fixture.chats.list()), /PRIVATE_PIXELS/);
  await page.click("#toggle-chat"); await page.evaluate(() => { window.__hold = true; });
  await page.fill("#question", "Read my screen"); await page.press("#question", "Enter");
  await page.waitForFunction(() => !!window.__resolveView && document.body.classList.contains("computer-active"));
  const plans = fixture.state.plans.length;
  await page.evaluate(() => window.__kaiEvent({ type: "computer", value: { stopped: true } }));
  await page.waitForFunction(() => !document.body.classList.contains("computer-active") && !document.querySelector("#send").hidden);
  assert.equal(fixture.state.plans.length, plans, "A late screen result after Stop never reaches inference");
  assert.equal(await page.evaluate(() => window.__cancelled), true); assert.deepEqual(errors, []);
});
