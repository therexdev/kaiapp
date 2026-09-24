"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("Master balances show both tokens and open a persistent node dashboard", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-sidebar-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const node = core.gateway.koinosNode, call = node.call.bind(node);
  let summary = { address: "cold-producer", network: "mainnet", tokenSymbol: "KOIN", koin: "1234.56789", vhp: "2000", usd: 161.7283945, price: { stale: false } }, offline = false;
  const allowed = new Set(["app:info", "wallet:status", "rewards:status"]);
  node.call = async (channel, payload) => {
    if (channel === "producer:summary" && !offline) return summary;
    if (allowed.has(channel)) return call(channel, payload);
    throw new Error("Network service unavailable in offline fixture");
  };
  const base = "http://127.0.0.1:" + await core.start();
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1253, height: 727 }, locale: "en-US" });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    window.koinosShell = { launchMascot: async () => {}, onMascotOpenView() {}, minimize() {}, toggleMaximize() {}, close() {}, onMaximizeChanged() {} };
  });
  await page.route("**/core/models", route => route.fulfill({ json: {
    aliases: [{ alias: "fast", label: "Koinos Fast", status: "ready" }],
    runtime: { runtime: { running: true }, activeAlias: "fast" },
  } }));
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById("sidebar-wallet-usd").textContent === "$161.73");
  assert.equal(await page.locator("#sidebar-wallet-koin").innerText(), "1,234.56789 KOIN");
  assert.equal(await page.locator("#sidebar-wallet-vhp").innerText(), "2,000 VHP");
  for (const size of [{ width: 1253, height: 727 }, { width: 1000, height: 620 }, { width: 680, height: 600 }]) {
    await page.setViewportSize(size);
    await page.waitForFunction(() => document.getElementById("status-text").textContent === "Model loaded");
    const layout = await page.evaluate(() => {
      const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
      return { launch: rect("launch-kai"), wallet: rect("sidebar-wallet"), model: rect("status-pane"), name: rect("status-model") };
    });
    assert.ok(layout.wallet.top >= layout.launch.bottom);
    assert.ok(layout.model.top >= layout.wallet.bottom);
    assert.ok(layout.model.height <= 34 && layout.name.height > 0, "model fits one visible row");
  }
  await page.setViewportSize({ width: 1253, height: 727 });
  if (process.env.KAI_MASCOT_QA_DIR) {
    fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
    await page.locator("#sidebar").screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, "master-sidebar-balances.png") });
  }
  summary = { ...summary, usd: null, price: { stale: true } };
  await page.evaluate(() => refreshSidebarWallet());
  assert.equal(await page.locator("#sidebar-wallet-usd").innerText(), "—");
  assert.equal(await page.locator("#sidebar-wallet-vhp").innerText(), "2,000 VHP");
  offline = true; await page.evaluate(() => refreshSidebarWallet());
  assert.equal(await page.locator("#sidebar-wallet-koin").innerText(), "— KOIN");
  assert.equal(await page.locator("#sidebar-wallet-vhp").innerText(), "— VHP");
  offline = false;
  for (const usd of [0, 0.0005]) {
    summary = { ...summary, usd, price: { stale: false } }; await page.evaluate(() => refreshSidebarWallet());
    assert.equal(await page.locator("#sidebar-wallet-usd").innerText(), usd === 0 ? "$0.00" : "<$0.01");
  }
  await page.click("#nav-settings"); await page.click("#sidebar-wallet");
  const frame = page.frameLocator("#koinos-frame");
  await frame.locator("#version-tag").filter({ hasText: /^v/ }).waitFor({ state: "attached" });
  await frame.locator("#d-status-text").waitFor();
  await page.evaluate(async () => { await refresh(); await refreshSidebarWallet(); await refresh(); });
  assert.equal(await page.locator("#view-koinos").isVisible(), true, "background polling does not undo navigation");
  // A previous inner node screen must not capture the balance shortcut.
  await page.evaluate(() => KaiKoinosNode.select("koinos-node"));
  await page.click("#nav-settings"); await page.click("#sidebar-wallet");
  await frame.locator('#view-dashboard.active').waitFor();
  assert.match(await page.locator('#kn-rail [data-knode="koinos"]').getAttribute("class"), /\bon\b/);
  const status = await (await fetch(base + "/core/koinos")).json();
  assert.equal(status.enabled, false, "balance navigation never enables the node");
  assert.equal(status.privacyMode, "local-only");
  assert.deepEqual(errors, []);
});
