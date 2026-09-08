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
    mascot.on("pageerror", error => console.error("Mascot renderer:", error.message));
    await mascot.waitForSelector("#kai-art svg");
    await mascot.waitForFunction(() => document.querySelector("#model").value === "tiny-live");
    const voiceStatus = await mascot.evaluate(() => window.kaiDesktop.windowsVoices());
    assert.ok(voiceStatus.available); assert.ok(voiceStatus.voices.length);
    const voiceBytes = await mascot.evaluate(async id => Array.from((await window.kaiDesktop.windowsSpeech({ voice: id, text: "Hey, I'm KAI." })).slice(0, 44)), voiceStatus.voices[0].id);
    assert.equal(Buffer.from(voiceBytes).toString("ascii", 0, 4), "RIFF", "Sandboxed Windows audio reaches the renderer for character processing");
    console.log("PASS: native fast Windows voice enumeration and PCM speech through the private companion preload.");
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
    await mascot.fill("#question", "Bring up my Pictures folder.");
    await mascot.press("#question", "Enter");
    await mascot.waitForFunction(() => document.querySelector("#messages").textContent.includes("left the folder closed") && document.querySelector("#stop").hidden);
    assert.equal(await app.evaluate(() => globalThis.__openedFolders.length), 0);
    await app.evaluate(() => { globalThis.__approveFolder = true; });
    await mascot.fill("#question", "Open my Pictures folder.");
    await mascot.press("#question", "Enter");
    await mascot.waitForFunction(() => document.querySelector("#messages").textContent.includes("Your Pictures folder is open") && document.querySelector("#stop").hidden);
    const folders = await app.evaluate(({ app }) => ({ opened: globalThis.__openedFolders, expected: app.getPath("pictures") }));
    assert.deepEqual(folders.opened, [folders.expected]);
    const refused = await mascot.evaluate(async () => { try { await window.kaiDesktop.openFolder("C:\\Windows\\System32\\cmd.exe"); return false; } catch { return true; } });
    assert.equal(refused, true);
    // Exercise the real sandboxed preload for app navigation and approvals.
    await mascot.evaluate(() => window.kaiDesktop.navigate("koinos-wallet"));
    assert.equal(await app.evaluate(() => globalThis.__kaiMain.isVisible()), true);
    assert.equal(await app.evaluate(() => globalThis.__kaiController.getWindow().isVisible()), true);
    assert.equal(await mascot.evaluate(async () => { try { await window.kaiDesktop.navigate("file:///C:/Windows"); return false; } catch { return true; } }), true);
    await app.evaluate(() => { globalThis.__approveFolder = false; });
    assert.equal(await mascot.evaluate(() => window.kaiDesktop.confirmTool("app_action", { action: "stop_node", args: {} })), false);
    await app.evaluate(() => { globalThis.__approveFolder = true; });
    assert.equal(await mascot.evaluate(() => window.kaiDesktop.confirmTool("app_action", { action: "stop_node", args: {} })), true);
    assert.equal(await app.evaluate(() => globalThis.__folderApprovals.at(-1).defaultId), 0);
    await app.evaluate(async () => { await globalThis.__kaiController.launch(); });
    await mascot.waitForFunction(() => document.querySelector("#conversation").hidden);
    assert.equal(await app.evaluate(() => globalThis.__kaiController.getWindow().getBounds().width), 248, "Relaunch collapses an open chat");
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2, "Relaunch reuses the same mascot");
    await mascot.click("#mascot-menu-button");
    await mascot.click("#menu-open-app");
    assert.equal(await app.evaluate(() => globalThis.__kaiMain.isVisible()), true);
    assert.equal(await app.evaluate(() => globalThis.__kaiController.getWindow().isVisible()), false);
    await main.click("#launch-kai");
    assert.equal(await app.evaluate(() => globalThis.__kaiController.getWindow().isVisible()), true);
    // Real sandboxed preload and native window movement, with only the cursor
    // supplied by the fixture. This never moves the runner's physical mouse.
    const drop = cancelled => mascot.evaluate(cancelled => new Promise(resolve => {
      const off = window.kaiDesktop.onEvent(({ type, value }) => {
        if (type === "placement" && Object.hasOwn(value, "landed")) { off(); resolve(); }
      });
      window.kaiDesktop.endDrag(cancelled);
    }), cancelled);
    const area = await app.evaluate(({ screen }) => {
      const w = globalThis.__kaiController.getWindow(), b = w.getBounds();
      globalThis.__kaiCursor = { x: b.x + b.width / 2, y: b.y + 100 };
      return screen.getDisplayNearestPoint(globalThis.__kaiCursor).workArea;
    });
    await mascot.evaluate(() => window.kaiDesktop.startDrag());
    await mascot.waitForFunction(() => document.body.dataset.pose === "carried");
    await app.evaluate((_electron, area) => { globalThis.__kaiCursor = { x: area.x + area.width / 2, y: area.y + area.height - 2 }; }, area);
    await drop(false);
    await mascot.waitForFunction(() => document.body.dataset.pose === "perched");
    const edge = await app.evaluate(() => globalThis.__kaiController.getWindow().getBounds());
    assert.equal(edge.y + edge.height, area.y + area.height, "Dropping at the bottom never jumps to the top");
    await mascot.evaluate(() => window.kaiDesktop.startDrag());
    await app.evaluate(() => { globalThis.__kaiCursor = { ...globalThis.__kaiCursor, x: globalThis.__kaiCursor.x - 80 }; });
    await drop(false);
    const slid = await app.evaluate(() => globalThis.__kaiController.getWindow().getBounds());
    assert.equal(slid.y, edge.y); assert.equal(slid.x, edge.x - 80);
    await mascot.evaluate(() => window.kaiDesktop.expand(true));
    assert.equal((await app.evaluate(() => globalThis.__kaiController.getWindow().getBounds())).y + 560, area.y + area.height);
    await mascot.evaluate(() => window.kaiDesktop.expand(false));
    await mascot.evaluate(() => window.kaiDesktop.startDrag());
    await app.evaluate(() => { globalThis.__kaiCursor = { ...globalThis.__kaiCursor, y: globalThis.__kaiCursor.y - 210 }; });
    await mascot.waitForFunction(() => document.body.dataset.pose === "carried");
    await drop(false);
    await mascot.waitForFunction(() => document.body.dataset.pose === "free");
    const lifted = await app.evaluate(() => globalThis.__kaiController.getWindow().getBounds());
    assert.ok(lifted.y + lifted.height < area.y + area.height - 24);
    await mascot.evaluate(() => window.kaiDesktop.startDrag());
    await mascot.waitForFunction(() => document.body.dataset.pose === "carried");
    await drop(true);
    await mascot.waitForFunction(() => document.body.dataset.pose === "free");
    await app.evaluate(() => { globalThis.__kaiCursor = null; });
    console.log("PASS: native pickup, bottom-edge drop, horizontal slide, lift, chat anchoring and drag cancellation.");
    // Real Windows safeStorage and sandboxed provider IPC; no paid APIs.
    assert.equal(await main.evaluate(async () => { try { await window.kaiProviderBridge.status(); return false; } catch { return true; } }), true, "Other Core documents have no provider capability");
    await app.evaluate(async () => {
      globalThis.__providerFixture.state.mainAtRoot = true;
      await globalThis.__kaiMain.loadURL(globalThis.__providerFixture.origin + "/");
    });
    const privateStatus = await main.evaluate(async () => {
      await window.kaiProviderBridge.save("openai", { key: "synthetic-native-provider-key", model: "gpt-fixture" });
      await window.kaiProviderBridge.save("anthropic", { key: "synthetic-native-provider-key", model: "claude-fixture" });
      return window.kaiProviderBridge.refresh("openai");
    });
    assert.equal(privateStatus.ok, true); assert.equal(JSON.stringify(privateStatus).includes("synthetic-native-provider-key"), false);
    const providerFile = await app.evaluate(() => globalThis.__providerService.file);
    assert.equal(fs.readFileSync(providerFile, "utf8").includes("synthetic-native-provider-key"), false);
    for (const [page, provider, model] of [[main, "openai", "gpt-fixture"], [mascot, "anthropic", "claude-fixture"]]) {
      const reply = await page.evaluate(async ({ provider, model }) => {
        const response = await window.KaiProviders.chatFetch("/core/chat/completions", { body: JSON.stringify({ model: `desktop:${provider}:${model}`, stream: false, messages: [{ role: "user", content: "Native fixture check" }] }) });
        return (await response.json()).choices[0].message.content;
      }, { provider, model });
      assert.equal(reply, "Native private reply.");
    }
    assert.equal(await mascot.evaluate(async () => { try { await window.kaiProviderBridge.remove("openai"); return false; } catch { return true; } }), true, "KAI cannot change provider credentials");
    console.log("PASS: native provider DPAPI encryption, private main/companion IPC, both streaming protocols and settings restrictions.");
    console.log("PASS: native KAI launch, transparent always-on-top window, sandbox, chat, resizing, single-window reuse, tray handoff and return to the main app.");
  } finally {
    await app?.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
