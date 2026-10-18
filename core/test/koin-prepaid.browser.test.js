"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { navClick } = require("./ui-nav"), CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
for (const product of ["prepaid-v1", "prepaid-usd-v1"]) test(product + " customer uses Buy credits and normal Chat; provider has ONLINE and Off", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-prepaid-ui-")), core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser; t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(product => {
    localStorage.setItem("kai-interface-language", "en"); window.calls = []; window.balance = "10000000"; window.provider = false;
    const listeners = new Set();
    window.kaiKoinTestBridge = { onProgress: callback => { listeners.add(callback); return () => listeners.delete(callback); }, run: async (action, input) => {
      window.calls.push({ action, input });
      const common = { enabled: true, configured: true, product, mode: "mainnet-pilot" };
      if (action === "chat-info") return { ...common, model: "koinos-fast", maxOutput: 128, blocked: "" };
      if (action === "status") return { ...common, accessReady: true, credits: { available: window.balance, purchased: "10000000", spent: "0", held: "0" }, purchases: [], usage: [], purchasePending: !!window.pendingPurchase, worker: { running: window.provider } };
      if (["purchase", "purchase-retry"].includes(action)) { window.pendingPurchase = true; return { ...common, state: "purchase_pending" }; }
      if (action === "chat-completion") {
        if (window.failChat) throw Error("No answer was delivered. Your credits are available; please try again.");
        if (window.streamChat) {
          for (const listener of listeners) listener({ requestId: "a".repeat(64), delta: "Prepaid ", servedModel: "koinos-fast", creditsAtoms: "100" });
          await new Promise(resolve => { window.finishStream = resolve; });
          if (window.interruptStream) throw Error("Connection interrupted. Recover your saved reply.");
        }
        window.balance = "9999875";
        return { id: "a".repeat(64), servedModel: "koinos-fast", choices: [{ message: { role: "assistant", content: "Prepaid answer" } }],
          koin: { product, receipt: { usage: { amount: "125" } } } };
      }
      if (action === "chat-ack") return { state: "delivered" };
      if (action === "worker-start") { window.provider = true; return {}; }
      if (action === "worker-stop") { window.provider = false; return {}; }
      if (action === "provider-status") return { state: window.provider ? "online" : "offline", label: window.provider ? "ONLINE" : "OFFLINE", detail: "Ready to provide AI", validUntil: Date.now() + 15000 };
      throw Error("Unexpected action " + action);
    } };
  }, product);
  await page.goto(`http://127.0.0.1:${await core.start()}`); await navClick(page, '.nav-item[data-view="earn"]');
  await page.locator("#koin-open-chat").click(); await page.locator("#network-chat-account").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("network-chat-balance").textContent === "100 credits");
  assert.equal(await page.locator("#network-add-koin").textContent(), "Buy credits");
  if (product === "prepaid-usd-v1") { assert.match(await page.locator("#network-chat-help").textContent(), /1,000 credits = \$1/); assert.doesNotMatch(await page.locator("#network-chat-help").textContent(), /1 KOIN =/); }
  assert.doesNotMatch(await page.locator("#network-chat-account").innerText(), /reservation|reserved|settlement|allowance/i);
  await page.fill("#network-koin-amount", "0.1"); await page.locator("#network-add-koin").click();
  await page.waitForFunction(() => !document.getElementById("network-add-koin").disabled);
  assert.match(await page.locator("#network-chat-status").textContent(), /Purchase confirming/);
  assert.equal(await page.locator("#network-retry-purchase").isVisible(), true);
  await page.locator("#network-retry-purchase").click();
  await page.waitForFunction(() => !document.getElementById("network-retry-purchase").disabled);
  if (product === "prepaid-usd-v1") { await page.locator("#network-free-only").check(); await page.evaluate(() => { window.streamChat = true; }); }
  await page.fill("#input", "Use my existing credits while the purchase confirms"); await page.locator("#btn-send").click();
  if (product === "prepaid-usd-v1") {
    await page.waitForFunction(() => document.getElementById("messages").textContent.includes("Prepaid ") && window.finishStream);
    assert.equal(await page.locator("#btn-send").isDisabled(), true);
    assert.equal(await page.evaluate(() => window.calls.find(c => c.action === "chat-completion").input.freeOnly), true);
    await page.evaluate(() => window.finishStream());
  }
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("Prepaid answer") && !document.getElementById("btn-send").disabled);
  assert.match(await page.locator("#messages").textContent(), /0.00125 credits/);
  if (product === "prepaid-usd-v1") {
    await page.evaluate(() => { window.interruptStream = true; window.finishStream = null; });
    await page.fill("#input", "Keep the interrupted prefix"); await page.locator("#btn-send").click();
    await page.waitForFunction(() => !!window.finishStream); await page.evaluate(() => window.finishStream());
    await page.waitForFunction(() => !document.getElementById("btn-send").disabled);
    assert.match(await page.locator("#messages").textContent(), /Keep the interrupted prefix/);
    assert.ok((await page.locator("#messages").textContent()).split("Prepaid").length >= 3);
    await page.evaluate(() => { window.streamChat = false; });
  }
  await page.evaluate(() => { window.failChat = true; }); await page.fill("#input", "Test failure"); await page.locator("#btn-send").click();
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("Your credits are available") && !document.getElementById("btn-send").disabled);
  const actions = await page.evaluate(() => window.calls.map(c => c.action));
  assert.equal(actions.filter(a => a === "purchase").length, 1); assert.ok(!actions.some(a => /reserve|session|release|refund/.test(a)));
  const qa = process.env.KAI_PREPAID_QA_DIR;
  if (qa) { fs.mkdirSync(qa, { recursive: true }); await page.screenshot({ path: path.join(qa, "prepaid-chat.png") }); }
  await page.locator("#network-account").click(); assert.equal(await page.locator("#koin-advanced").isVisible(), false);
  assert.equal(await page.locator('[data-koin-test="refund"]').isVisible(), false);
  await page.locator("#koin-earn-tab").click(); await page.locator('[data-koin-test="worker-start"]').click();
  await page.waitForFunction(() => document.getElementById("koin-provider-state").textContent === "ONLINE");
  if (qa) await page.locator("#koin-test-payments").screenshot({ path: path.join(qa, "prepaid-provider.png") });
  await page.locator('[data-koin-test="worker-stop"]').click(); await page.waitForFunction(() => document.getElementById("koin-provider-state").textContent === "OFFLINE");
  await page.setViewportSize({ width: 480, height: 900 }); assert.equal(await page.locator("#koin-test-payments").evaluate(n => n.scrollWidth <= n.clientWidth), true);
});
