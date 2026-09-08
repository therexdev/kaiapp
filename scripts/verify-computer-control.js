"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert/strict");
const { NativeComputer } = require("../electron/native-computer");
const { ComputerControl } = require("../electron/computer-control");
async function main() {
  if (process.platform !== "win32") throw new Error("Verify native desktop control on Windows.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-computer-qa-"));
  let browser, control;
  const native = new NativeComputer({ ...(process.argv.includes("--packaged") ? { executable: path.resolve("dist/win-unpacked/resources/bin/kai-computer.exe") } : {}) });
  try {
    const env = { ...process.env, KAI_COMPUTER_QA_PROFILE: dir }; delete env.ELECTRON_RUN_AS_NODE;
    browser = await require("playwright-core")._electron.launch({ executablePath: require("electron"), args: [path.join(__dirname, "fixtures/computer-browser.js")], env, timeout: 30000 });
    const page = await browser.firstWindow(); await page.waitForSelector("#play");
    await browser.evaluate(({ app }) => { app.focus({ steal: true }); globalThis.__qaWindow.focus(); });
    const approvals = []; let approve = true;
    control = new ComputerControl({ native, getWindow: () => ({ isVisible: () => true, isDestroyed: () => false }),
      describeModel: () => ({ kind: "local", vision: true }), globalShortcut: { register: () => true, unregister() {} },
      dialog: { showMessageBox: async (_window, spec) => { approvals.push(spec); return { response: approve ? 1 : 0 }; } }, shell: {} });
    const session = await control.begin({ task: "Find The Test Movie and play it", model: "qa-local" });
    let out = await control.call(session.id, "computer_look", {});
    assert.match(out.screen.window.title, /KAI browser control fixture/);
    assert.match(out.screen.image, /^data:image\/png;base64,/); assert.ok(out.screen.imageWidth <= 1280);
    assert.ok(!JSON.stringify(out.screen).includes("MUST_NOT_READ"), "Password values never leave native UIA");
    assert.ok(out.screen.elements.some(e => e.password && !e.value), "A visible password field is marked and redacted");
    const find = name => { const item = out.screen.elements.find(e => e.name === name); assert.ok(item, `Observed ${name}; controls: ${JSON.stringify(out.screen.elements)}`); return item.id; };
    out = await control.call(session.id, "computer_type", { frame: out.screen.frame, element: find("Search movies"), text: "The Test Movie" });
    assert.equal(await page.inputValue("#search"), "The Test Movie", "Real UIA typed into Chromium");
    out = await control.call(session.id, "computer_key", { frame: out.screen.frame, key: "ENTER" });
    assert.equal(await page.textContent("#search-result"), "Results for The Test Movie", "Native keyboard input submits the search");
    out = await control.call(session.id, "computer_click", { frame: out.screen.frame, element: find("Play") });
    assert.equal(await page.textContent("#output"), "Playing The Test Movie", "Real UIA invoked the browser Play button");
    assert.ok(out.screen.elements.some(e => /Playing The Test Movie/.test(e.name)), "Post-action view verifies the outcome");
    assert.equal(approvals.length, 1, "Ordinary search and Play use the approved task");
    const point = (name, portion = .5) => {
      const b = out.screen.elements.find(e => e.name === name && (name !== "Volume" || e.role === "Slider"))?.bounds; assert.ok(b, "Visible coordinates for " + name);
      return { x: Math.round(b.x + b.width * portion), y: Math.round(b.y + b.height / 2) };
    };
    out = await control.call(session.id, "computer_point", { frame: out.screen.frame, ...point("Show subtitles"), reason: "Show subtitles checkbox" });
    assert.equal(await page.isChecked("#subtitles"), true, "Native pointer input hits the reviewed screenshot coordinate");
    const start = point("Volume", .12), end = point("Volume", .8);
    out = await control.call(session.id, "computer_drag", { frame: out.screen.frame, ...start, toX: end.x, toY: end.y, reason: "Raise the visible Volume slider" });
    assert.ok(Number(await page.inputValue("#volume")) > 65, "Native drag adjusts the real browser slider");
    assert.equal(approvals.length, 3, "Both coordinate operations require separate review");
    approve = false;
    await assert.rejects(control.call(session.id, "computer_click", { frame: out.screen.frame, element: find("Rent for $9.99") }), /declined/);
    assert.equal(await page.textContent("#output"), "Playing The Test Movie", "Declined rental never executes");
    assert.equal(control.status().active, false);
    approve = true;
    const next = await control.begin({ task: "Read my screen", model: "qa-local" });
    out = await control.call(next.id, "computer_look", {});
    out = await control.call(next.id, "computer_scroll", { frame: out.screen.frame, direction: "down", amount: 2 });
    assert.ok(await page.evaluate(() => window.scrollY > 0), "Native mouse wheel scrolls the browser");
    out = await control.call(next.id, "computer_scroll", { frame: out.screen.frame, direction: "up", amount: 5 });
    const frame = out.screen.frame, element = find("Pause");
    await browser.evaluate(() => { const w = globalThis.__qaWindow, [x, y] = w.getPosition(); w.setPosition(x + 20, y + 10); });
    await assert.rejects(control.call(next.id, "computer_click", { frame, element }), /window moved/i);
    const visual = await native.request({ op: "look", accessibility: false, image: true });
    assert.equal(visual.elements.length, 0); assert.match(visual.image, /^data:image\/png/);
    console.log("PASS: actual Windows UIA reads Chromium and redacts passwords; native input submits a search, clicks coordinates, drags a slider and scrolls; Play is verified, Rent is declined, stale windows are refused, and screenshots are bounded.");
    console.log("Helper:", native.executable);
  } finally { control?.cancel(); native.cancel(); await browser?.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
