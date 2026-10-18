"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("Revision 2 free entry, unified credits, unavailable quote, stale network and Back to Earn preserve sharing", { skip: !fs.existsSync(CHROMIUM), timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-product-ui-")), core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  core.settings.set("network.privacyMode", "local-first");
  let browser; t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 } }), errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en"); window.productCalls = []; window.productSharing = false; window.networkFails = false;
    const listeners = new Set(), common = { enabled: true, configured: true, product: "prepaid-usd-v1", mode: "mainnet-pilot", owner: "fixture-owner" };
    const credit = () => ({ unit: "USD-1e-8", version: "1", available: "25000000", purchased: { available: "0", purchased: "0", spent: "0", held: "0" }, free: { state: "available", available: "25000000", resetAt: Date.now() + 3600000 }, observedAt: Date.now() });
    const purchases = [{ id: "fixture-pending", state: "pending", createdAt: Date.now() }];
    window.kaiKoinTestBridge = { onProgress: fn => { listeners.add(fn); return () => listeners.delete(fn); }, run: async (action, input) => {
      window.productCalls.push({ action, input });
      if (action === "chat-info") return { ...common, activation: "ready", runBudgets: window.advancedReady === true, blocked: "", model: "fixture", maxOutput: 32, maxRequestCredits: "1" };
      if (action === "credit-status") return { ...common, credits: credit(), purchases, usage: [] };
      if (action === "status") return { ...common, accessReady: true, credits: credit().purchased, creditState: credit(), purchases, usage: [], purchasePending: true, worker: { running: window.productSharing } };
      if (action === "worker-start") { window.productSharing = true; return { state: "test_worker_running" }; }
      if (action === "worker-stop") { window.productSharing = false; return { state: "test_worker_stopped" }; }
      if (action === "provider-public-info") return { state: "ready", enabled: window.productSharing, running: window.productSharing, model: { id: "fixture", label: "Fixture", installed: true, requiredRamGb: 4 }, detail: "Fixture model is installed" };
      if (action === "provider-public-earnings") return { observedAt: Date.now(), lastCycleCheck: null, payouts: [{ epoch: "20742", state: "needs_review", availability: "10000000", work: "0" }] };
      if (action === "provider-public-start") { window.productSharing = true; return { state: "running" }; }
      if (action === "provider-public-stop") { window.productSharing = false; return { state: "offline" }; }
      if (["provider-status", "provider-public-status"].includes(action)) return { state: window.productSharing ? "online" : "offline", label: window.productSharing ? "ONLINE" : "OFFLINE", detail: "Fixture qualification and serving evidence are current", validUntil: Date.now() + 15000 };
      if (action === "purchase-preview") {
        if (!window.previewFixture) throw Error("Current purchase pricing is unavailable. Existing credits are still usable.");
        await new Promise(resolve => { window.resolvePreview = resolve; });
        return { quote: { id: "fixture-quote", koin: "1", observedAt: Date.now(), expiresAt: Date.now() + 60000 } };
      }
      if (action === "purchase-approve") { await new Promise(resolve => { window.resolveApproval = resolve; }); return { state: "cancelled" }; }
      if (action === "network-overview") {
        if (window.networkFails) throw Error("Connection lost");
        const observedAt = Date.now(); return { ...common, network: { observedAt, validUntil: observedAt + 1500, state: "available", readyProviders: 1, waitingRequests: 2, completedToday: 3,
          models: [{ id: "fixture", providers: 1, available: true, freeEligible: true }], providers: [{ id: "anonymous", model: "fixture", state: "ready" }], activity: [{ at: observedAt, model: "fixture" }] } };
      }
      if (action === "run-open") { window.latestRun = { id: String(window.productCalls.length).padStart(64, "0"), mode: input.mode, maxTotal: "100000", freeOnly: input.freeOnly, state: "open", createdAt: Date.now() }; return { run: window.latestRun }; }
      if (action === "run-list") return { runs: window.latestRun ? [window.latestRun] : [] };
      if (action === "run-status") return { run: { ...window.latestRun, spent: "20" }, steps: [{ text: "Saved useful intermediate result", credits: "10", callId: "c".repeat(64) }] };
      if (action === "run-stop") { window.latestRun.state = "stopped"; window.resolveCreditTeam?.(); return { run: window.latestRun }; }
      if (action === "run-execute") {
        for (const fn of listeners) fn({ runId: input.runId, trace: { stage: "writer", type: "model", detail: "Saved intermediate" } });
        if (window.pauseCreditTeam) await new Promise(r => { window.resolveCreditTeam = r; });
        return { answer: "Budgeted team result", modelCalls: 2 };
      }
      if (["chat-completion", "run-chat"].includes(action)) { for (const fn of listeners) fn({ requestId: "a".repeat(64), delta: "Free verified reply", servedModel: "fixture", creditsAtoms: "10" }); return { id: "a".repeat(64), servedModel: "fixture", choices: [{ message: { role: "assistant", content: "Free verified reply" } }], koin: { product: "prepaid-usd-v1", receipt: { usage: { amount: "10" } } } }; }
      if (action === "chat-ack") return { state: "delivered" };
      if (action === "stop") return {};
      throw Error("Unexpected fixture action: " + action);
    } };
  });
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  await page.locator('[data-product-action="setup-local"]').click();
  assert.equal(await page.locator("#btn-download").isVisible(), true);
  await page.locator('[data-product-action="first-back"]').click();
  assert.equal(await page.locator("#btn-download").isVisible(), false);
  await page.locator('[data-product-action="start-free"]').click();
  await page.locator("#view-chat").waitFor({ state: "visible" });
  await page.fill("#input", "Use the free account without a payment wallet"); await page.locator("#btn-send").click();
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("Free verified reply") && !document.getElementById("btn-send").disabled);
  assert.equal(await page.evaluate(() => window.productCalls.some(c => /purchase-approve|reserve|release|import|access/.test(c.action))), false);
  assert.equal(await page.locator("#sidebar #chat-search").isVisible(), true);
  await page.locator('.product-sidebar-credits [data-product-view="credits"]').click();
  await page.waitForFunction(() => document.querySelector('#view-credits [data-credit-total]').textContent === "250");
  assert.equal(await page.locator('.product-sidebar-credits [data-credit-total]').textContent(), "250");
  await page.locator('#view-credits [data-product-view="buy-credits"]').click(); await page.locator('[data-credit-pack="5"]').click(); await page.locator("#product-quote-refresh").click();
  await page.waitForFunction(() => document.getElementById("product-quote-state").textContent.includes("pricing is unavailable"));
  assert.equal(await page.locator("#product-quote-approve").isVisible(), false);
  assert.match(await page.locator("#product-pending-purchases").textContent(), /keep using existing credits/);
  // An amount edit invalidates an in-flight quote, and repeated approval clicks
  // cannot dispatch a second payment. This fixture never signs or sends money.
  await page.evaluate(() => { window.previewFixture = true; });
  await page.locator("#product-quote-refresh").click();
  await page.waitForFunction(() => !!window.resolvePreview);
  await page.fill("#product-usd-amount", "10"); await page.evaluate(() => window.resolvePreview());
  await page.waitForFunction(() => !document.getElementById("product-quote-refresh").disabled);
  assert.equal(await page.locator("#product-quote-approve").isVisible(), false);
  await page.evaluate(() => { window.resolvePreview = null; });
  await page.locator("#product-quote-refresh").click(); await page.waitForFunction(() => !!window.resolvePreview);
  await page.evaluate(() => window.resolvePreview()); await page.locator("#product-quote-approve").waitFor({ state: "visible" });
  await page.evaluate(() => { const b = document.getElementById("product-quote-approve"); b.click(); b.click(); });
  await page.waitForFunction(() => !!window.resolveApproval);
  assert.equal(await page.evaluate(() => window.productCalls.filter(c => c.action === "purchase-approve").length), 1);
  await page.evaluate(() => window.resolveApproval());
  await page.waitForFunction(() => document.getElementById("product-quote-state").textContent.includes("Payment cancelled"));
  assert.equal(await page.locator("#product-quote-approve").isVisible(), false);
  await page.locator('#nav [data-view="chat"]').click();
  assert.equal(await page.locator('#mode-pick option[value="agent"]').isDisabled(), true, "unsupported billing is disabled before Send");
  await page.evaluate(async () => {
    window.advancedReady = true; await KaiNetwork.refresh(); KaiNetwork.paint();
    const original = KaiAgents.makeRuntime;
    const phase = options => async (text, model) => {
      await options.askModelOnce([{ role: "user", content: text }], model);
      return { context: "Useful gathered context", citations: [], trace: "Intermediate result saved" };
    };
    KaiAgents.makeRuntime = options => ({ ...original(options), runAgent: phase(options), deepResearch: phase(options) });
  });
  await page.selectOption("#mode-pick", "agent"); await page.fill("#input", "Run the budgeted agent"); await page.click("#btn-send");
  await page.locator("#credit-run-review").waitFor({ state: "visible" });
  if (process.env.KAI_PRODUCT_QA_DIR) { fs.mkdirSync(process.env.KAI_PRODUCT_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.KAI_PRODUCT_QA_DIR, "advanced-run-budget.png") }); }
  await page.locator('#credit-run-review button[value="cancel"]').click();
  assert.equal(await page.evaluate(() => window.productCalls.filter(c => c.action === "run-open").length), 0);
  assert.equal(await page.inputValue("#input"), "Run the budgeted agent");
  await page.click("#btn-send"); await page.fill("#credit-run-budget", "1"); await page.click("#credit-run-start");
  await page.waitForFunction(() => window.productCalls.filter(c => c.action === "run-chat").length === 2 && !document.getElementById("btn-send").disabled);
  assert.equal(await page.evaluate(() => window.productCalls.filter(c => c.action === "run-chat").every(c => c.input.request.max_tokens === 32)), true);
  await page.locator("#credit-run-results > summary").click(); await page.locator("#credit-run-history summary").first().click();
  await page.waitForFunction(() => document.getElementById("credit-run-history").textContent.includes("Saved useful intermediate result"));
  await page.selectOption("#mode-pick", "research"); await page.fill("#input", "Run budgeted research"); await page.click("#btn-send");
  await page.fill("#credit-run-budget", "1"); await page.click("#credit-run-start");
  await page.waitForFunction(() => window.productCalls.filter(c => c.action === "run-chat").length === 4 && !document.getElementById("btn-send").disabled);
  await page.selectOption("#mode-pick", "team:review"); await page.fill("#input", "Run a budgeted team"); await page.click("#btn-send");
  await page.fill("#credit-run-budget", "1"); await page.click("#credit-run-start");
  await page.waitForFunction(() => document.getElementById("messages").textContent.includes("Budgeted team result") && !document.getElementById("btn-send").disabled);
  assert.equal(await page.evaluate(() => window.productCalls.filter(c => c.action === "run-execute").length), 1);
  await page.evaluate(() => { window.pauseCreditTeam = true; });
  await page.fill("#input", "Stop a budgeted team"); await page.click("#btn-send"); await page.fill("#credit-run-budget", "1"); await page.click("#credit-run-start");
  await page.waitForFunction(() => !!window.resolveCreditTeam); await page.click("#btn-stop");
  await page.waitForFunction(() => !document.getElementById("btn-send").disabled);
  assert.match(await page.locator("#messages").textContent(), /Stopped/);
  await page.locator('#nav [data-view="earn"]').click();
  await page.locator('[data-product-action="payouts"]').click();
  await page.waitForFunction(() => document.getElementById("product-provider-earnings").textContent.includes("needs review"));
  assert.match(await page.locator("#product-provider-earnings").textContent(), /20742.*0\.10000000 KOIN.*needs review/);
 await page.locator("#product-provider-toggle").click();
  await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "ONLINE");
  await page.locator('.product-earn [data-product-view="network-overview"]').click();
  await page.waitForFunction(() => document.getElementById("product-provider-count").textContent === "1");
  await page.waitForFunction(() => document.getElementById("product-network-time").textContent.includes("stale"));
  assert.equal(await page.locator('[data-network-model="fixture"]').isDisabled(), true);
  await page.locator('#view-network-overview [data-product-view="earn"]').click();
  assert.equal(await page.evaluate(() => window.productSharing), true);
  assert.equal(await page.evaluate(() => window.productCalls.some(c => c.action === "worker-stop")), false);
  await page.locator("#product-provider-toggle").click(); await page.waitForFunction(() => !window.productSharing);
  await page.setViewportSize({ width: 480, height: 900 }); await page.locator("#product-sidebar-close").click();
  assert.equal(await page.locator("#product-mobile-buy").isVisible(), true); await page.locator("#product-mobile-buy").click();
  assert.equal(await page.locator("#view-buy-credits").evaluate(n => n.scrollWidth <= n.clientWidth), true);
  assert.deepEqual(errors, []);
});
