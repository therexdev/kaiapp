"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert/strict");
const { _electron: electron } = require("playwright-core");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mascot-native-"));
  let app;
  try {
    const env = { ...process.env, KAI_MASCOT_NATIVE_DATA: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ executablePath: require("electron"), args: [path.join(__dirname, "fixtures/mascot-desktop.js")], env, timeout: 30000 });
    const main = await app.firstWindow();
    await main.waitForSelector("#launch-kai:not([hidden])");
    const nextWindow = app.waitForEvent("window");
    await main.click("#launch-kai");
    const mascot = await nextWindow;
    await mascot.waitForSelector("#kai-art svg");
    await mascot.waitForFunction(() => document.querySelector("#model").value === "tiny-live");
    let native = await app.evaluate(({ BrowserWindow }) => {
      const w = globalThis.__kaiController.getWindow();
      return { count: BrowserWindow.getAllWindows().length, mainVisible: globalThis.__kaiMain.isVisible(),
        visible: w.isVisible(), top: w.isAlwaysOnTop(), resize: w.isResizable(),
        background: w.getBackgroundColor(), bounds: w.getBounds(), preferences: w.webContents.getLastWebPreferences() };
    });
    assert.equal(native.count, 2); assert.equal(native.mainVisible, false); assert.equal(native.visible, true);
    assert.equal(native.top, true); assert.equal(native.resize, false);
    assert.equal(native.preferences.sandbox, true); assert.equal(native.preferences.nodeIntegration, false);
    assert.equal(native.preferences.contextIsolation, true); assert.equal(native.bounds.width, 248);
    const anchor = { x: native.bounds.x + native.bounds.width, y: native.bounds.y + native.bounds.height };
    await mascot.click("#toggle-chat");
    await mascot.waitForSelector("#conversation:not([hidden])");
    native = await app.evaluate(() => globalThis.__kaiController.getWindow().getBounds());
    assert.equal(native.width, 660);
    assert.equal(native.x + native.width, anchor.x); assert.equal(native.y + native.height, anchor.y);
    await mascot.fill("#question", "Hello KAI");
    await mascot.press("#question", "Enter");
    await mascot.waitForFunction(() => document.querySelector("#messages").textContent.includes("What are you working on today") && document.querySelector("#stop").hidden);
    await mascot.click("#collapse");
    await mascot.waitForFunction(() => document.querySelector("#conversation").hidden);
    await app.evaluate(async () => { await globalThis.__kaiController.launch(); });
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2, "Relaunch reuses the same mascot");
    await mascot.click("#mascot-menu-button");
    await mascot.click("#menu-open-app");
    assert.equal(await app.evaluate(() => globalThis.__kaiMain.isVisible()), true);
    assert.equal(await app.evaluate(() => globalThis.__kaiController.getWindow().isVisible()), false);
    await main.click("#launch-kai");
    assert.equal(await app.evaluate(() => globalThis.__kaiController.getWindow().isVisible()), true);
    console.log("PASS: native KAI launch, transparent always-on-top window, sandbox, chat, resizing, single-window reuse, tray handoff and return to the main app.");
  } finally {
    await app?.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
