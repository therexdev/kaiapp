"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), os = require("os"), { EventEmitter } = require("events");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("Agents workspace creates, quotes, runs and reviews a real isolated workflow through private IPC", { skip: !fs.existsSync(CHROMIUM), timeout: 90000 }, async t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-agent-ui-"));
 const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent: () => {} }), origin = "http://127.0.0.1:" + await core.start();
 const { CompanionHub, registerCompanionIPC } = require("../../electron/companion-hub"), handlers = new Map(), reviewed = [];
 const hub = new CompanionHub({ dataDir: dir, safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).reverse(), decryptString: b => Buffer.from(b).reverse().toString() }, models: () => [], canUseModel: () => true, privacyMode: () => "local-only", runLocal: async () => "not used" });
 const wc = new EventEmitter(); wc.id = 12; wc.mainFrame = { url: origin + "/" }; wc.getURL = () => origin + "/"; wc.isDestroyed = () => false;
 const win = new EventEmitter(); win.webContents = wc; win.isVisible = () => true; win.isDestroyed = () => false;
 const ipc = registerCompanionIPC({ ipcMain: { handle: (k, f) => handlers.set(k, f), removeHandler: k => handlers.delete(k) }, service: hub, origin, getMainWindow: () => win, getMascotWindow: () => null, dialog: { showMessageBox: async (_w, data) => { reviewed.push(data); return { response: 1 }; } } });
 const browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] }), page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
 t.after(async () => { ipc.dispose(); await browser.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
 const errors = []; page.on("pageerror", e => errors.push(e.message));
 await page.exposeFunction("fixtureIPC", (channel, ...args) => handlers.get(channel)({ sender: wc, senderFrame: wc.mainFrame }, ...args));
 await page.addInitScript(() => { window.kaiCompanionBridge = { manage: (a, p) => window.fixtureIPC("companion:manage", a, p), context: (m, q) => window.fixtureIPC("companion:context", m, q), tools: m => window.fixtureIPC("companion:tools", m), tool: (n, a, m) => window.fixtureIPC("companion:tool", n, a, m), cancel: () => window.fixtureIPC("companion:cancel") }; });
 await page.goto(origin + "/"); await page.click('[data-view="agents"]'); await page.click('[data-an="tab"][data-id="settings"]'); await page.check('#view-agents [name="enabled"]'); await page.click('#view-agents button[type="submit"]');
 await page.click('[data-an="tab"][data-id="mine"]'); await page.locator('[data-an="create"]').first().click(); await page.fill('#view-agents [name="name"]', 'Connection check <safe>'); await page.fill('#view-agents [name="description"]', 'Returns only the selected input'); await page.click('#view-agents button[type="submit"]');
 await page.click('[data-an="hire"]'); await page.fill('#view-agents [name="input"]', 'Selected text <script>safe</script>'); await page.click('#view-agents button[type="submit"]');
 await page.waitForSelector('[data-an="submit"]'); await page.click('[data-an="submit"]'); await page.waitForSelector('[data-an="accept"]');
 assert.match(await page.locator('#view-agents').innerText(), /Selected text <script>safe<\/script>/); assert.equal(await page.locator('#view-agents script').count(), 0);
 for (const width of [1280, 960, 720]) { await page.setViewportSize({ width, height: 900 }); const size = await page.locator('.an-content').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth })); assert.ok(size.scroll <= size.width + 2, "Agent workspace overflow"); if (process.env.KAI_MASCOT_QA_DIR) { fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, `agent-network-job-${width}.png`) }); } }
 await page.click('[data-an="accept"]'); assert.equal(hub.agentNetwork.status().jobs.find(j => j.role === 'buyer').status, 'accepted'); assert.equal(reviewed.length, 2);
 assert.deepEqual(errors, []);
});
