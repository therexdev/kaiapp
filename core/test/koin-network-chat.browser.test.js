"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { navClick } = require("./ui-nav");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("normal Chat uses existing KOIN without a deposit, validates Add KOIN, and provider ONLINE expires", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
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
  await page.goto(base); await navClick(page, '.nav-item[data-view="earn"]');
  await page.locator("#koin-open-chat").click();
  await page.locator("#network-chat-account").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("network-chat-balance").textContent.includes("0.10000000"));
  assert.match(await page.locator("#network-chat-help").textContent(), /existing balance.*approve a reservation.*Add KOIN deposits/);
  assert.equal(await page.locator('label[for="network-koin-amount"]').isVisible(), true);
  for (const value of ["", " ", "0", "0.00000000", "-0.1", "0.1 KOIN", "0.123456789", "1e-1", "184467440737.09551616"]) {
    await page.fill("#network-koin-amount", value); await page.locator("#network-add-koin").click();
    assert.match(await page.locator("#network-chat-status").textContent(), /To add funds.*To reserve your existing balance, send a chat message/);
    assert.equal(await page.locator("#network-koin-amount").getAttribute("aria-invalid"), "true");
    assert.equal(await page.evaluate(() => document.activeElement.id), "network-koin-amount");
  }
  assert.equal(await page.evaluate(() => window.paidCalls.filter(c => c.action === "purchase").length), 0);
  // The existing balance can be used from Chat without entering a deposit.
  await page.fill("#network-koin-amount", "");
  await page.fill("#input", "Hello network"); await page.locator("#btn-send").click();
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("Network reply 1") && !document.getElementById("btn-send").disabled);
  assert.match(await page.locator("#messages").textContent(), /0.00000125 KOIN/);
  assert.doesNotMatch(await page.locator("#messages").textContent(), /tok\/s/);
  await page.fill("#input", "And a follow-up"); await page.locator("#btn-send").click();
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("Network reply 2") && !document.getElementById("btn-send").disabled);
  const chats = await page.evaluate(() => window.paidCalls.filter(c => c.action === "chat-completion"));
  assert.equal(chats.length, 2); assert.ok(chats[1].input.messages.some(m => m.role === "assistant" && m.content === "Network reply 1"));
  assert.equal(legacyRequests, 0);
  assert.equal(await page.evaluate(() => window.paidCalls.filter(c => c.action === "purchase").length), 0);
  await page.evaluate(() => { window.chatError = true; });
  await page.fill("#input", "Continue my existing reservation"); await page.locator("#btn-send").click();
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("Your existing reservation is preserved") && !document.getElementById("btn-send").disabled);
  assert.doesNotMatch(await page.locator("#messages").textContent(), /Error invoking remote method/);
  await page.evaluate(() => { window.chatError = false; });
  await page.fill("#network-koin-amount", " 0.12345678 "); await page.locator("#network-add-koin").click();
  await page.waitForFunction(() => !document.getElementById("network-add-koin").disabled);
  assert.deepEqual(await page.evaluate(() => window.paidCalls.filter(c => c.action === "purchase")), [{ action: "purchase", input: "0.12345678" }]);
  assert.equal(await page.locator("#network-koin-amount").getAttribute("aria-invalid"), null);
  await page.evaluate(() => { window.purchaseError = true; });
  await page.locator("#network-add-koin").click();
  await page.waitForFunction(() => !document.getElementById("network-add-koin").disabled);
  assert.equal(await page.locator("#network-chat-status").textContent(), "Native approval cancelled");
  await page.evaluate(() => {
    window.balance = "0"; window.reserved = "10000000";
    window.expiredReservations = [{ session: "b".repeat(64), remaining: "10000000", releaseAfter: Date.now() + 3600000, canRelease: false }];
    window.dispatchEvent(new Event("kai-network-account-changed"));
  });
  await page.waitForFunction(() => document.getElementById("network-chat-reservation").textContent.includes("settlement window ends"));
  assert.equal(await page.locator("#network-chat-reservation").isVisible(), true);
  assert.match(await page.locator("#network-chat-reservation").textContent(), /0.10000000 KOIN.*No additional deposit is required/);
  await page.evaluate(() => { window.expiredReservations[0].canRelease = true; window.dispatchEvent(new Event("kai-network-account-changed")); });
  await page.waitForFunction(() => document.getElementById("network-chat-reservation").textContent.includes("Send your message to review its release"));
  assert.equal(await page.evaluate(() => window.paidCalls.filter(c => c.action === "release").length), 0);
  await page.setViewportSize({ width: 480, height: 900 });
  assert.equal(await page.locator("#network-chat-account").evaluate(n => n.scrollWidth <= n.clientWidth), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  const qa = process.env.KAI_MASCOT_QA_DIR;
  if (qa) { fs.mkdirSync(qa, { recursive: true }); await page.screenshot({ path: path.join(qa, "koin-normal-chat.png") }); }
  await page.evaluate(() => { window.expiredReservations = []; window.balance = "10000000"; window.reserved = "0"; window.dispatchEvent(new Event("kai-network-account-changed")); });
  await page.waitForFunction(() => document.getElementById("network-chat-reservation").hidden);
  await page.locator("#network-account").click();
  await page.fill("#koin-test-amount", ""); await page.locator('[data-koin-test="purchase"]').click();
  assert.equal(await page.locator("#koin-test-amount").getAttribute("aria-invalid"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.id), "koin-test-amount");
  assert.equal(await page.evaluate(() => window.paidCalls.filter(c => c.action === "purchase").length), 2);
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
