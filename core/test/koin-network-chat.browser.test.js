"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("earlier KOIN account remains in explicit recovery; provider ONLINE expires without renewed qualification", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-network-ui-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser; t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${await core.start()}`;
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let legacyRequests = 0;
  await page.route("**/core/chat/completions", route => { legacyRequests++; return route.fulfill({ status: 500, body: "Paid chat must use private IPC" }); });
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en"); window.paidCalls = []; window.providerOn = false;
    window.providerEligible = true; window.balance = "10000000";
    window.kaiKoinTestBridge = { onProgress: callback => { window.chatProgress = callback; return () => {}; }, run: async (action, input) => {
      window.paidCalls.push({ action, input });
      if (action === "chat-info") return { enabled: true, configured: true, mode: "mainnet-pilot", model: "koinos-fast", maxOutput: 128, blocked: "" };
      if (action === "status") return { enabled: true, configured: true, mode: "mainnet-pilot", accessReady: true, balances: { available: window.balance, reserved: window.reserved || "0" }, expiredReservations: window.expiredReservations || [], transactions: [], worker: { running: window.providerOn }, session: null };
      if (action === "purchase") {
        if (window.purchaseError) throw Error("Error invoking remote method 'koin:test-payments': Error: Native approval cancelled");
        return { state: "finalized", funding: { state: "funded" } };
      }
      if (action === "chat-completion") {
        if (window.chatError) throw Error("Error invoking remote method 'koin:test-payments': Error: Spending approval is still waiting for network confirmation. Your existing reservation is preserved. Send the same message again to continue");
        window.chatProgress?.({ text: "The network is generating your answer…" });
        return { id: "a".repeat(64), servedModel: "koinos-fast", choices: [{ message: { role: "assistant", content: "Network reply " + input.messages.filter(m => m.role === "user").length } }],
          koin: { state: "verified", receipt: { usage: { amount: "125" } } } };
      }
      if (action === "chat-ack") return { state: "delivered" };
      if (action === "worker-start") { window.providerOn = true; return { state: "test_worker_running" }; }
      if (action === "worker-stop") { window.providerOn = false; return { state: "test_worker_stopped" }; }
      if (action === "provider-status") return !window.providerOn ? { state: "offline", label: "OFFLINE", detail: "Turn on to provide AI." } :
        window.providerEligible ? { state: "online", label: "ONLINE", detail: "Connected and eligible for paid work.", validUntil: Date.now() + 1000 } : { state: "qualification-expired", label: "RENEWAL REQUIRED", detail: "Provider qualification expired." };
      throw Error("Unexpected action " + action);
    } };
  });
  await page.goto(base); await page.locator('.product-sidebar-credits [data-product-view="credits"]').click();
  await page.locator('#view-credits .product-footer [data-product-action="legacy"]').click();
  await page.waitForFunction(() => document.getElementById("koin-available").textContent.includes("0.10000000"));
  assert.equal(await page.locator('.product-sidebar-credits [data-credit-total]').textContent(), "—", "old KOIN is never relabelled USD credits");
  for (const value of ["", "0", "-0.1", "0.1 KOIN", "0.123456789", "1e-1"]) {
    await page.fill("#koin-test-amount", value); await page.locator('[data-koin-test="purchase"]').click();
    assert.equal(await page.locator("#koin-test-amount").getAttribute("aria-invalid"), "true");
  }
  assert.equal(await page.evaluate(() => window.paidCalls.filter(c => c.action === "purchase").length), 0);
  assert.equal(legacyRequests, 0);
  const qa = process.env.KAI_MASCOT_QA_DIR;
  await page.locator("#koin-earn-tab").click();
  await page.locator('[data-koin-test="worker-start"]').click();
  await page.waitForFunction(() => document.getElementById("koin-provider-state").textContent === "ONLINE");
  assert.equal(await page.locator("#koin-provider-state").getAttribute("data-state"), "online");
  if (qa) await page.locator("#koin-test-payments").screenshot({ path: path.join(qa, "koin-online-provider.png") });
  await page.waitForFunction(() => document.getElementById("koin-provider-state").textContent === "CHECKING CONNECTION");
  await page.locator('[data-koin-test="worker-stop"]').click();
  await page.waitForFunction(() => document.getElementById("koin-provider-state").textContent === "OFFLINE");
  await page.evaluate(() => { window.providerEligible = false; });
  await page.locator('[data-koin-test="worker-start"]').click();
  await page.waitForFunction(() => document.getElementById("koin-provider-state").textContent === "RENEWAL REQUIRED");
  assert.equal(await page.locator("#koin-provider-state").getAttribute("data-state"), "qualification-expired");
  await page.setViewportSize({ width: 480, height: 900 });
  assert.equal(await page.locator("#koin-test-payments").evaluate(n => n.scrollWidth <= n.clientWidth), true);
});
