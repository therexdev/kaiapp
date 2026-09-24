"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("sidebar wallet renders money, unknowns, translations and a compact model row", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-sidebar-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  const base = "http://127.0.0.1:" + await core.start();
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1253, height: 727 }, locale: "en-US" });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en");
    window.kaiLanguageBridge = { get: async () => ({ language: "en", selected: true }), onChanged() {} };
    window.koinosShell = { launchMascot: async () => {}, onMascotOpenView() {}, minimize() {}, toggleMaximize() {}, close() {}, onMaximizeChanged() {} };
  });
  await page.route("**/core/models", route => route.fulfill({ json: {
    aliases: [{ alias: "fast", label: "Koinos Fast", status: "ready" }],
    runtime: { runtime: { running: true }, activeAlias: "fast" },
  } }));
  let summary = { address: "earning-wallet", network: "mainnet", tokenSymbol: "KOIN", koin: "1234.56789", usd: 61.7283945, price: { stale: false } };
  let offline = false;
  await page.route("**/core/koinos/rpc", route => route.request().postDataJSON().channel === "wallet:summary"
    ? route.fulfill({ status: offline ? 503 : 200, json: { ok: !offline, data: summary } }) : route.continue());
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById("sidebar-wallet-usd").textContent === "$61.73");
  assert.equal(await page.locator("#sidebar-wallet-koin").innerText(), "1,234.56789 KOIN");
  for (const size of [{ width: 1253, height: 727 }, { width: 1000, height: 620 }, { width: 680, height: 600 }]) {
    await page.setViewportSize(size);
    await page.waitForFunction(() => document.getElementById("status-text").textContent === "Model loaded");
    const layout = await page.evaluate(() => {
      const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
      return { launch: rect("launch-kai"), wallet: rect("sidebar-wallet"), model: rect("status-pane"), name: rect("status-model") };
    });
    assert.ok(layout.wallet.top >= layout.launch.bottom);
    assert.ok(layout.model.top >= layout.wallet.bottom);
    assert.ok(layout.model.height <= 34 && layout.name.height > 0, "model stays one visible row even in short windows");
  }
  await page.setViewportSize({ width: 1253, height: 727 });
  if (process.env.KAI_MASCOT_QA_DIR) {
    fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
    await page.locator("#sidebar").screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, "sidebar-wallet.png") });
  }
  summary = { ...summary, usd: null, price: { stale: true } };
  await page.evaluate(() => refreshSidebarWallet());
  assert.equal(await page.locator("#sidebar-wallet-usd").innerText(), "—");
  assert.equal(await page.locator("#sidebar-wallet-koin").innerText(), "1,234.56789 KOIN");
  await page.evaluate(() => KaiI18n.setLanguage("de"));
  assert.equal(await page.locator("#sidebar-wallet-koin").innerText(), "1.234,56789 KOIN");
  assert.equal(await page.locator("#sidebar-wallet").getAttribute("title"), "Der KOIN-Preis ist veraltet");
  offline = true; await page.evaluate(() => refreshSidebarWallet());
  assert.equal(await page.locator("#sidebar-wallet-usd").innerText(), "—");
  assert.equal(await page.locator("#sidebar-wallet-koin").innerText(), "— KOIN");
  offline = false; summary = { address: null };
  await page.evaluate(() => refreshSidebarWallet());
  assert.equal(await page.locator("#sidebar-wallet-koin").innerText(), "Wallet einrichten");
  let wallet = {};
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet, worker: { running: false } } }));
  for (const example of [
    { wallet: { exists: false, unlocked: false }, control: "#earn-setup" },
    { wallet: { exists: true, unlocked: false, address: "earning-wallet" }, control: "#earn-unlock" },
    { wallet: { exists: true, unlocked: true, address: "earning-wallet" }, control: "#wallet-address" },
  ]) {
    wallet = example.wallet;
    await page.click("#nav-settings");
    await page.locator("#view-settings:not([hidden])").waitFor();
    await page.click("#sidebar-wallet");
    // Exercise the same polls that used to restore the previous page a
    // second after the click. The wallet contents must also initialize.
    await page.evaluate(async () => { await refresh(); await refreshSidebarWallet(); await refresh(); });
    assert.equal(await page.locator("#view-earn").isVisible(), true, "wallet navigation survives background refreshes");
    await page.locator(example.control).waitFor({ state: "visible", timeout: 5000 });
    if (wallet.unlocked) assert.equal(await page.inputValue("#wallet-address"), wallet.address);
  }
  assert.deepEqual(errors, []);
});
