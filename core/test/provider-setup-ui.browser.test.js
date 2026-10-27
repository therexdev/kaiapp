"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { navClick } = require("./ui-nav");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("Earn setup clicks acknowledge pending checks, show current blockers and recover after a lost reply", { skip: !fs.existsSync(CHROMIUM), timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-setup-ui-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser; t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1911, height: 1138 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en"); window.providerCalls = [];
    window.providerInfo = { state: "wallet-required", enabled: false, running: false,
      blocked: "Unlock your wallet using Reward wallet, then check setup again.",
      detail: 'Unexpected token "<", "<!DOCTYPE" is not valid JSON',
      model: { id: "koinos-smart", label: "Koinos Smart", requiredRamGb: 8, installed: true } };
    window.providerInfo.models = [window.providerInfo.model, { id: "koinos-fast", label: "Koinos Fast", requiredRamGb: 3, installed: true }];
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async (action, input) => {
      window.providerCalls.push(action);
      if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "chat-info") return { enabled: true, configured: false, blocked: "Fixture not activated" };
      if (action === "provider-public-info") {
        const info = structuredClone(window.providerInfo);
        if (window.holdInfo) await new Promise(resolve => { window.finishInfo = resolve; });
        return info;
      }
      if (action === "provider-public-start") { window.providerInfo = { ...window.providerInfo, enabled: true, running: true }; return { state: "running" }; }
      if (action === "provider-public-model") {
        window.providerInfo.model = window.providerInfo.models.find(m => m.id === input);
        return { state: "model-selected", model: input };
      }
      if (action === "provider-public-stop") { window.providerInfo = { ...window.providerInfo, enabled: false, running: false }; return { state: "offline" }; }
      if (action === "provider-public-status") return { state: "qualifying", label: "CHECKING MODEL", detail: "Waiting for fresh signed qualification." };
      throw Error("Fixture unavailable");
    } };
  });
  await page.route("**/core/models", route => route.fulfill({ json: { aliases: [{ alias: "koinos-smart", label: "Koinos Smart", status: "ready" }], runtime: { runtime: { running: false }, activeAlias: null } } }));
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet: { exists: true, unlocked: false, address: "fixture-wallet" }, worker: { running: false } } }));
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  await navClick(page, '#nav [data-view="earn"]');
  const reload = page.locator("#product-provider-reload"), toggle = page.locator("#product-provider-toggle"), notice = page.locator("#product-provider-refresh");
  await page.waitForFunction(() => document.getElementById("product-provider-detail").textContent.includes("Unlock"));
  assert.equal(await page.locator("#product-provider-start-hint").isVisible(), true);
  assert.equal(await toggle.evaluate(el => getComputedStyle(el).backgroundColor), "rgb(183, 47, 64)");
  assert.equal(await toggle.isDisabled(), true); assert.match(await page.locator("#product-provider-setup").textContent(), /Unlock/);
  assert.doesNotMatch(await page.locator("#product-provider-setup").textContent(), /DOCTYPE/);
  if (process.env.KAI_PREPAID_QA_DIR) {
    fs.mkdirSync(process.env.KAI_PREPAID_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "provider-setup-required.png"), animations: "disabled" });
  }
  await page.evaluate(() => { window.holdInfo = true; });
  const before = await page.evaluate(() => window.providerCalls.filter(x => x === "provider-public-info").length);
  await reload.click(); await page.waitForFunction(() => !!window.finishInfo);
  assert.equal(await reload.textContent(), "Checking setup…"); assert.match(await notice.textContent(), /Checking wallet/);
  await reload.click();
  assert.equal(await page.evaluate(() => window.providerCalls.filter(x => x === "provider-public-info").length), before + 1, "clicks join the pending read");
  await page.evaluate(() => { window.holdInfo = false; window.finishInfo(); });
  await page.waitForFunction(() => document.getElementById("product-provider-refresh").textContent.startsWith("Setup checked at"));
  assert.equal(await reload.textContent(), "Reload setup");
  await page.evaluate(() => { window.providerInfo = { ...window.providerInfo, state: "unavailable", blocked: "" }; });
  await reload.click();
  await page.waitForFunction(() => document.getElementById("product-provider-detail").textContent.includes("web page instead of setup data"));
  assert.equal(await toggle.isDisabled(), true, "an HTML response cannot enable sharing");
  await page.locator('#view-earn [data-product-action="payment-wallet"]').click();
  await page.locator("#earn-unlock").waitFor({ state: "visible" });
  assert.equal(await page.locator("#view-payment-wallet").isVisible(), true);
  await navClick(page, '#nav [data-view="earn"]');
  assert.equal(await page.locator('#view-earn [data-product-action="signin"]').count(), 0, "earning no longer routes setup through a buyer account");
  await page.waitForFunction(() => !document.getElementById("product-provider-reload").hasAttribute("aria-busy"));
  // pauseAt installs and pauses the clock in one call. Starting a running
  // clock first can overtake a separately sampled host time on loaded CI.
  // Exercise the actual deadline without a 15-second wall wait.
  const frozenAt = new Date();
  await page.clock.pauseAt(frozenAt);
  assert.equal(await page.evaluate(() => Date.now()), frozenAt.getTime());
  await page.evaluate(() => { window.holdInfo = true; window.finishInfo = null; });
  await reload.click(); await page.waitForFunction(() => !!window.finishInfo);
  await page.clock.runFor(15001);
  await page.waitForFunction(() => document.getElementById("product-provider-setup").textContent.includes("timed out"));
  assert.equal(await reload.isEnabled(), true); assert.equal(await toggle.isDisabled(), true);
  await page.evaluate(() => { window.lateInfo = window.finishInfo; window.holdInfo = false; window.providerInfo = { ...window.providerInfo, state: "ready", blocked: "", detail: "Ready to connect and check model quality." }; });
  await reload.click(); await page.waitForFunction(() => !document.getElementById("product-provider-toggle").disabled);
  await page.evaluate(() => window.lateInfo());
  assert.match(await page.locator("#product-provider-setup").textContent(), /Ready to connect/, "late timed-out reads cannot restore an old blocker");
  assert.equal(await page.evaluate(() => window.providerCalls.some(x => x === "provider-public-start")), false);
  await page.locator("#product-provider-options > summary").click();
  const picker = page.locator("#product-provider-model-pick");
  await picker.selectOption("koinos-fast");
  await page.waitForFunction(() => document.getElementById("product-provider-model").textContent === "Koinos Fast");
  await picker.selectOption("koinos-smart");
  await page.waitForFunction(() => document.getElementById("product-provider-model").textContent === "Koinos Smart");
  assert.equal(await page.evaluate(() => window.providerCalls.some(x => x === "provider-public-start")), false, "choosing a model keeps sharing Off");
  if (process.env.KAI_PREPAID_QA_DIR) await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "provider-model-selection.png"), animations: "disabled" });
  await toggle.click(); await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "CHECKING MODEL");
  assert.equal(await toggle.textContent(), "Stop earning"); assert.equal(await toggle.isEnabled(), true);
  assert.equal(await page.locator("#product-provider-start-hint").isVisible(), false);
  assert.equal(await toggle.evaluate(el => getComputedStyle(el).backgroundColor), "rgb(22, 128, 82)");
  assert.ok((await toggle.boundingBox()).height >= 44, "earning control has an obvious click target");
  assert.equal(await picker.isDisabled(), true);
  await toggle.click(); await page.waitForFunction(() => document.getElementById("product-provider-toggle").textContent === "Start earning");
  assert.equal(await page.locator("#product-provider-start-hint").isVisible(), true);
  assert.equal(await toggle.evaluate(el => getComputedStyle(el).backgroundColor), "rgb(183, 47, 64)");
  assert.equal(await page.evaluate(() => window.providerCalls.filter(x => x === "provider-public-start").length), 1);
  assert.equal(await page.evaluate(() => window.providerCalls.filter(x => x === "provider-public-stop").length), 1);
  assert.equal(await picker.inputValue(), "koinos-smart"); assert.equal(await picker.isEnabled(), true);
  await page.evaluate(() => { window.providerInfo.automatic = true; window.providerInfo.offeredModels = ["koinos-smart", "koinos-fast"]; });
  await reload.click(); await page.waitForFunction(() => document.getElementById("product-provider-model-choice").hidden);
  assert.match(await page.locator("#product-provider-model").textContent(), /Koinos Smart.*Koinos Fast/);
  await page.locator("#product-provider-options > summary").click();
  await toggle.click(); await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "CHECKING MODEL");
  assert.equal(await toggle.textContent(), "Stop earning");
  assert.equal(await picker.isVisible(), false, "automatic sharing does not ask for a model selection");
  if (process.env.KAI_PREPAID_QA_DIR) await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "provider-one-click.png"), animations: "disabled" });
  assert.equal(await page.evaluate(() => window.providerCalls.some(x => ["chat-completion", "run-chat"].includes(x))), false);
  assert.deepEqual(errors, []);
});

test("Earn distinguishes a passing local diagnostic from failed network checks and shows actual progress and retry time", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-progress-ui-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser; t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en"); window.providerCalls = [];
    const model = { id: "koinos-smart", label: "Koinos Smart", installed: true, requiredRamGb: 8 };
    const local = { state: "complete", stage: "complete", detail: "Local candidate answers matched.", completed: 12, total: 12, passed: 12, reportAvailable: true, model };
    window.kaiProviderCheckBridge = { status: async () => local, start: async () => { throw Error("No new local check should run"); }, cancel: async () => local,
      copy: async () => ({}), save: async () => ({}), onProgress: () => () => {} };
    window.networkQualification = { state: "failed", passed: 0, completed: 12, total: 12, retryAt: Date.now() + 300000 };
    window.networkState = "qualification-failed";
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async action => {
      window.providerCalls.push(action);
      if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "chat-info") return { enabled: true, configured: false, blocked: "Fixture" };
      if (action === "provider-public-info") return { state: "ready", enabled: true, running: true, automatic: true, model, models: [model], offeredModels: [model.id], detail: "Sharing is on." };
      if (action === "provider-public-status") {
        if (window.statusUnavailable) throw Error("Provider status unavailable");
        return { state: window.networkState, model: model.id, label: window.networkState === "qualification-failed" ? "NETWORK CHECK FAILED" : window.networkState === "online" ? "ONLINE" : "CHECKING MODEL",
          detail: "The network check has not passed. Keep earning on; another check runs automatically.", qualification: window.networkQualification, validUntil: Date.now() + 15000 };
      }
      throw Error("Fixture unavailable");
    } };
  });
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  await navClick(page, '#nav [data-view="earn"]');
  const progress = page.locator("#product-provider-qualification"), reload = page.locator("#product-provider-reload");
  await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "NETWORK CHECK FAILED");
  await page.locator("#product-provider-options > summary").click();
  assert.match(await page.locator("[data-check-summary]").textContent(), /12 candidate answers matched/);
  assert.match(await progress.textContent(), /Network check: 0\/12 passed · 12\/12 completed.*Koinos Smart/);
  const retryTime = await page.evaluate(() => new Date(window.networkQualification.retryAt).toLocaleTimeString());
  assert.ok((await progress.textContent()).includes("Automatic retry scheduled for " + retryTime));
  assert.equal(await page.locator("#product-provider-label").getAttribute("data-state"), "qualification-failed");
  assert.match(await page.locator("#product-provider-readiness").textContent(), /local check is diagnostic/);
  assert.match(await page.locator("#product-provider-setup").textContent(), /Sharing is on/);
  assert.doesNotMatch(await page.locator("#product-provider-setup").textContent(), /Ready to connect/);
  assert.doesNotMatch(await page.locator("#product-provider-detail").textContent(), /quality|latency|run.*local/i);
  if (process.env.KAI_PREPAID_QA_DIR) { fs.mkdirSync(process.env.KAI_PREPAID_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "provider-network-progress.png"), animations: "disabled" }); }
  await page.evaluate(() => { window.networkState = "qualifying"; window.networkQualification = { state: "testing", passed: 3, completed: 4, total: 12, retryAt: null }; });
  await reload.click(); await page.waitForFunction(() => document.getElementById("product-provider-qualification").textContent.includes("3/12 passed"));
  assert.match(await progress.textContent(), /4\/12 completed/); assert.doesNotMatch(await progress.textContent(), /retry scheduled/);
  assert.notEqual(await page.locator("#product-provider-label").getAttribute("data-state"), "online");
  await page.evaluate(() => { window.networkQualification = undefined; }); await reload.click();
  await page.waitForFunction(() => document.getElementById("product-provider-qualification").hidden);
  assert.equal(await page.locator("#product-provider-label").textContent(), "CHECKING MODEL", "older backend without counters remains readable");
  await page.evaluate(() => { window.networkState = "online"; }); await reload.click();
  await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "ONLINE");
  assert.match(await page.locator("#product-provider-readiness").textContent(), /qualification current.*fresh network confirmation/);
  await page.evaluate(() => { window.statusUnavailable = true; }); await reload.click();
  await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "CONNECTION UNCONFIRMED");
  assert.equal(await progress.isVisible(), false);
  assert.match(await page.locator("#product-provider-readiness").textContent(), /Readiness is not confirmed/);
  assert.doesNotMatch(await page.locator("#product-provider-readiness").textContent(), /qualification current|fresh network confirmation/);
  assert.equal(await page.evaluate(() => window.providerCalls.some(x => /start|stop|purchase|sign/.test(x))), false);
  assert.deepEqual(errors, []);
});

async function sharingFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-model-sharing-ui-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  const browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  t.after(async () => { await browser.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en"); window.providerCalls = []; window.accountSequence = 0;
    const names = ["Smart", "Fast", "Coder", "Vision", "Think", "Pro", "Plus", "Reason", "Writer", "Mini"];
    window.sharedModels = names.map(name => ({ id: "koinos-" + name.toLowerCase(), label: "Koinos " + name, installed: true, compatible: true, requiredRamGb: 8 }));
    window.providerSelection = { mode: "all", models: [] }; window.earningOn = true;
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async (action, input) => {
      window.providerCalls.push({ action, input });
      const selected = () => window.providerSelection.mode === "all" ? window.sharedModels.map(model => model.id) : window.providerSelection.models;
      if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "chat-info") return { enabled: true, configured: false, blocked: "Fixture" };
      if (action === "provider-public-info") {
        const info = { state: "ready", enabled: window.earningOn, running: window.earningOn, automatic: true, model: window.sharedModels[0], models: structuredClone(window.sharedModels), selection: structuredClone(window.providerSelection), offeredModels: selected(),
          modelAvailability: [...structuredClone(window.sharedModels), { id: "koinos-large", label: "Koinos Large", installed: true, compatible: false, reason: "Needs 64 GB; this computer has 32 GB RAM." }], detail: "Sharing is on." };
        if (window.holdInfo) await new Promise(resolve => { window.finishInfo = resolve; });
        if (window.infoError) throw Error("Connection unavailable"); return info;
      }
      if (action === "provider-public-status") {
        const until = Date.now() + 15000, smart = { model: "koinos-smart", state: "online", label: "ONLINE", detail: "Smart is qualified.", validUntil: until };
        const result = window.onlyTop ? smart : { ...smart, models: [smart,
          { model: "koinos-fast", state: "review-required", label: "REVIEW REQUIRED", detail: "The network must approve this model before paid work.", validUntil: until },
          { model: "koinos-coder", state: "qualifying", label: "CHECKING MODEL", detail: "Network check in progress.", validUntil: until, qualification: { state: "testing", passed: 2, completed: 3, total: 12, retryAt: null } }] };
        if (window.holdStatus) await new Promise(resolve => { window.finishStatus = resolve; });
        return result;
      }
      if (action === "provider-public-models") {
        const accountSequence = window.accountSequence;
        if (window.holdSelection) await new Promise((resolve, reject) => { window.finishSelection = resolve; window.cancelSelection = reject; });
        if (accountSequence === window.accountSequence) window.providerSelection = structuredClone(input);
        return { state: "models-selected" };
      }
      if (action === "provider-public-stop") { window.earningOn = false; window.cancelSelection?.(Error("Sharing update stopped")); return { state: "offline" }; }
      throw Error("Fixture unavailable");
    } };
  });
  await page.route("**/core/models", route => route.fulfill({ json: { aliases: [], runtime: { runtime: { running: false }, activeAlias: null } } }));
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet: { exists: true, unlocked: true, address: "fixture-wallet" }, worker: { running: false } } }));
  await page.goto(`http://127.0.0.1:${await core.start()}`); await navClick(page, '#nav [data-view="earn"]');
  await page.waitForFunction(() => document.getElementById("product-provider-model-summary").textContent.includes("10 selected · 1 ready"));
  return { page, reload: page.locator("#product-provider-reload"), toggle: page.locator("#product-provider-toggle"), all: page.locator("#product-provider-share-all"), apply: page.locator("#product-provider-models-apply"),
    row: id => page.locator(`[data-shared-model="${id}"]`), check: id => page.locator(`[data-provider-shared-model="${id}"]`) };
}

test("Earn explains each failed model with verified counts and bounded local errors without inventing readiness", { skip: !fs.existsSync(CHROMIUM), timeout: 90000 }, async t => {
  const { page, reload, toggle, row } = await sharingFixture(t);
  await page.evaluate(() => {
    const original = window.kaiKoinTestBridge.run;
    window.kaiKoinTestBridge.run = async (action, input) => {
      const result = await original(action, input);
      if (action === "provider-public-info") result.modelDiagnostics = [
        { model: "koinos-smart", code: "inference_failed", at: Date.now() },
        { model: "koinos-vision", code: "tokenizer_mismatch", at: Date.now(), message: "private runtime path" },
        { model: "koinos-think", code: "private server text", at: Date.now() }];
      if (action === "provider-public-status") {
        const fail = (model, qualification) => ({ model, state: "qualification-failed", label: "NETWORK CHECK FAILED", validUntil: Date.now() + 15000, qualification });
        result.models = [result.models[0],
          fail("koinos-fast", { state: "failed", passed: 10, completed: 12, total: 12, required: 12, retryAt: Date.now() + 300000,
            failure: { code: "quality", wrongAnswers: 2, deadlines: 0, unknown: 0 } }),
          fail("koinos-coder", { state: "failed", passed: 0, completed: 12, total: 12, required: 12, retryAt: Date.now() + 300000,
            failure: { code: "deadline", wrongAnswers: 0, deadlines: 12, unknown: 0 } }),
          fail("koinos-vision", { state: "failed", passed: 0, completed: 0, total: 12, retryAt: Date.now() + 300000 }),
          fail("koinos-think"),
          fail("koinos-pro", { state: "failed", passed: 3, completed: 3, total: 12, required: 12, retryAt: Date.now() + 300000,
            failure: { code: "preparation_timeout", wrongAnswers: 0, deadlines: 0, unknown: 0 } }),
          { model: "koinos-plus", state: "qualifying", label: "CHECKING MODEL", validUntil: Date.now() + 15000,
            qualification: { state: "testing", passed: 0, completed: 0, total: 12, required: 12, phase: "preparing", retryAt: null } }];
      }
      return result;
    };
  });
  await reload.click();
  await page.waitForFunction(() => document.querySelector('[data-shared-model="koinos-fast"]').textContent.includes("10/12 passed"));
  assert.match(await row("koinos-fast").textContent(), /10\/12 passed · 12\/12 completed.*Required: 12\/12.*2 answers did not match.*Automatic retry scheduled/);
  assert.match(await row("koinos-coder").textContent(), /12 checks did not finish before the deadline/);
  assert.doesNotMatch(await row("koinos-coder").textContent(), /did not match the required output/);
  assert.match(await row("koinos-vision").textContent(), /0\/12 completed.*Required score was not reported.*did not report a complete failure reason.*Last local check error.*tokenizer/);
  assert.doesNotMatch(await row("koinos-vision").textContent(), /Model preparation did not finish/);
  assert.match(await row("koinos-think").textContent(), /did not provide check results or a failure reason/);
  assert.match(await row("koinos-pro").textContent(), /3\/12 passed · 3\/12 completed.*Model preparation did not finish/);
  assert.match(await row("koinos-plus").textContent(), /Preparing model.*Preparing the model before timed checks/);
  assert.doesNotMatch(await row("koinos-smart").textContent(), /Last local check error/);
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 1);
  assert.doesNotMatch(await page.locator("#product-provider-model-list").textContent(), /private runtime path|private server text/);
  if (process.env.KAI_PREPAID_QA_DIR) {
    fs.mkdirSync(process.env.KAI_PREPAID_QA_DIR, { recursive: true });
    await page.locator("#product-provider-models-open").click();
    await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "provider-failure-details.png"), animations: "disabled" });
    await page.setViewportSize({ width: 780, height: 560 });
    await page.locator("#product-provider-models").evaluate(node => node.scrollIntoView({ block: "start" }));
    assert.equal(await page.locator("#view-earn").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "provider-failure-details-narrow.png"), animations: "disabled" });
  }
  await toggle.click(); await page.waitForFunction(() => document.getElementById("product-provider-toggle").textContent === "Start earning");
  assert.doesNotMatch(await page.locator("#product-provider-model-list").textContent(), /Last local check error/);
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 0);
});

test("Earn exposes all installed models and applies a subset without confusing selection with network readiness", { skip: !fs.existsSync(CHROMIUM), timeout: 90000 }, async t => {
  const { page, reload, toggle, all, apply, row, check } = await sharingFixture(t);
  assert.equal(await all.isChecked(), true);
  assert.equal(await page.locator("[data-provider-shared-model]:checked").count(), 10);
  assert.equal(await page.locator("[data-shared-model]").count(), 11);
  assert.equal(await apply.isVisible(), false);
  assert.match(await row("koinos-smart").textContent(), /Available for paid work/);
  assert.match(await row("koinos-fast").textContent(), /Network approval needed/);
  assert.match(await row("koinos-coder").textContent(), /Checking model.*2\/12 passed/);
  assert.match(await row("koinos-vision").textContent(), /Waiting for network qualification/);
  assert.equal(await check("koinos-large").isDisabled(), true); assert.match(await row("koinos-large").textContent(), /Needs 64 GB/);
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 1);
  assert.equal(await page.locator("#product-provider-models-open").isVisible(), true);
  assert.match(await page.locator("#product-provider-model").textContent(), /All compatible installed models \(10\)/);
  if (process.env.KAI_PREPAID_QA_DIR) { fs.mkdirSync(process.env.KAI_PREPAID_QA_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "provider-all-models.png"), animations: "disabled" }); }
  await page.locator("#product-provider-models-open").click();
  const modelTop = await page.locator("#product-provider-models").boundingBox(), header = await page.locator(".workspace-header").boundingBox();
  assert.ok(modelTop.y >= header.y + header.height && modelTop.y + modelTop.height <= page.viewportSize().height, "Choose shared models brings the complete fixture list into view below the header");
  if (process.env.KAI_PREPAID_QA_DIR) {
    await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "provider-model-statuses.png"), animations: "disabled" });
    await page.setViewportSize({ width: 780, height: 560 }); await page.locator("#product-provider-models").evaluate(node => node.scrollIntoView({ block: "start" }));
    assert.equal(await page.locator("#view-earn").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: path.join(process.env.KAI_PREPAID_QA_DIR, "provider-model-statuses-narrow.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1440, height: 1040 });
  }
  await check("koinos-smart").uncheck(); assert.equal(await all.isChecked(), false);
  await reload.click(); await page.waitForFunction(() => !document.getElementById("product-provider-reload").hasAttribute("aria-busy"));
  assert.equal(await check("koinos-smart").isChecked(), false, "periodic setup reads preserve unapplied choices");
  assert.match(await row("koinos-smart").textContent(), /Will stop sharing after Apply/);
  await page.evaluate(() => { window.holdStatus = true; }); await reload.click(); await page.waitForFunction(() => !!window.finishStatus);
  await page.evaluate(() => { window.oldReadyReply = window.finishStatus; window.holdStatus = false; });
  await page.evaluate(() => { window.holdSelection = true; }); await apply.click(); await page.waitForFunction(() => !!window.finishSelection);
  assert.equal(await page.locator("#product-provider-label").textContent(), "UPDATING SHARING");
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 0);
  assert.equal(await toggle.isEnabled(), true); assert.equal(await toggle.textContent(), "Stop earning");
  await reload.click(); await page.waitForFunction(() => !document.getElementById("product-provider-reload").hasAttribute("aria-busy"));
  assert.notEqual(await page.locator("#product-provider-label").textContent(), "ONLINE", "a status reply during Apply cannot restore the previous selection’s readiness");
  await page.evaluate(() => { window.holdSelection = false; window.finishSelection(); });
  await page.waitForFunction(() => document.getElementById("product-provider-model-summary").textContent.includes("9 selected · 0 ready"));
  assert.match(await page.locator("#product-provider-model-summary").textContent(), /No selected model is currently confirmed ready/);
  assert.match(await row("koinos-smart").textContent(), /Not shared/);
  await page.evaluate(() => window.oldReadyReply());
  assert.match(await page.locator("#product-provider-model-summary").textContent(), /9 selected · 0 ready/);
  assert.equal(await check("koinos-smart").isChecked(), false, "a pre-Apply status reply cannot restore the old selection");
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 0);
  assert.equal(await toggle.textContent(), "Stop earning");
  await all.check(); await apply.click();
  await page.waitForFunction(() => document.getElementById("product-provider-model-summary").textContent.includes("10 selected · 1 ready"));
  assert.deepEqual(await page.evaluate(() => window.providerCalls.filter(call => call.action === "provider-public-models").map(call => call.input)), [
    { mode: "selected", models: ["koinos-fast", "koinos-coder", "koinos-vision", "koinos-think", "koinos-pro", "koinos-plus", "koinos-reason", "koinos-writer", "koinos-mini"] }, { mode: "all", models: [] }]);
  await all.uncheck(); assert.equal(await apply.isDisabled(), true, "an empty selection cannot be applied");
  await page.locator("#product-provider-models-reset").click(); assert.equal(await all.isChecked(), true);
  await page.evaluate(() => { window.onlyTop = true; }); await reload.click();
  await page.waitForFunction(() => document.querySelector('[data-shared-model="koinos-fast"]').textContent.includes("Waiting for network qualification"));
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 1, "older single-model status never qualifies the other selected models");
  assert.equal(await page.evaluate(() => window.providerCalls.some(call => ["chat-completion", "run-chat", "provider-public-start", "provider-public-model"].includes(call.action))), false);
});

test("Earn stops pending selection, fences old-account replies and removes expired model readiness", { skip: !fs.existsSync(CHROMIUM), timeout: 90000 }, async t => {
  const { page, reload, toggle, all, apply, row, check } = await sharingFixture(t);
  await check("koinos-smart").uncheck(); await page.evaluate(() => { window.holdSelection = true; }); await apply.click();
  await page.waitForFunction(() => !!window.cancelSelection);
  await page.evaluate(() => { window.holdStatus = true; }); await reload.click(); await page.waitForFunction(() => !!window.finishStatus);
  await page.evaluate(() => { window.oldReadyReply = window.finishStatus; window.holdStatus = false; });
  await toggle.click();
  await page.waitForFunction(() => document.getElementById("product-provider-toggle").textContent === "Start earning");
  assert.equal(await page.evaluate(() => window.earningOn), false);
  await page.evaluate(() => window.oldReadyReply());
  assert.equal(await toggle.textContent(), "Start earning", "a pre-Stop status reply cannot restore earning or readiness");
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 0);
  await page.locator("#product-provider-models-reset").click();
  await page.evaluate(() => { window.earningOn = true; window.holdSelection = false; }); await reload.click();
  await page.waitForFunction(() => document.getElementById("product-provider-label").textContent === "ONLINE");
  await check("koinos-smart").uncheck(); await page.evaluate(() => { window.holdSelection = true; window.finishSelection = null; }); await apply.click();
  await page.waitForFunction(() => !!window.finishSelection);
  await page.evaluate(() => {
    window.oldSelectionReply = window.finishSelection; window.holdSelection = false; window.accountSequence++;
    window.sharedModels = [{ id: "koinos-new", label: "New account model", installed: true, compatible: true, requiredRamGb: 4 }];
    window.providerSelection = { mode: "all", models: [] }; window.dispatchEvent(new Event("kai-credit-identity-changed"));
  });
  await page.waitForFunction(() => document.getElementById("product-provider-model-list").textContent.includes("New account model"));
  await page.evaluate(() => window.oldSelectionReply());
  assert.equal(await check("koinos-smart").count(), 0); assert.equal(await all.isChecked(), true);
  assert.doesNotMatch(await page.locator("#product-provider-selection-status").textContent(), /selection saved/);
  assert.equal(await page.locator("#product-provider-label").textContent(), "WAITING FOR NETWORK");
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 0);
  await page.evaluate(() => { window.holdInfo = true; window.finishInfo = null; }); await reload.click(); await page.waitForFunction(() => !!window.finishInfo);
  await page.evaluate(() => {
    window.oldInfoReply = window.finishInfo; window.holdInfo = false; window.accountSequence++;
    window.sharedModels = [{ id: "koinos-smart", label: "Current account Smart", installed: true, compatible: true, requiredRamGb: 4 }];
    window.dispatchEvent(new Event("kai-credit-identity-changed"));
  });
  await page.waitForFunction(() => document.getElementById("product-provider-model-list").textContent.includes("Current account Smart"));
  await page.evaluate(() => window.oldInfoReply());
  assert.equal(await check("koinos-new").count(), 0);
  await page.clock.pauseAt(new Date());
  await page.evaluate(() => { window.infoError = true; }); await page.clock.runFor(15001);
  await page.waitForFunction(() => document.querySelector('[data-shared-model="koinos-smart"]').textContent.includes("Checking connection"));
  assert.equal(await page.locator('.product-model-status[data-state="online"]').count(), 0);
  assert.match(await page.locator("#product-provider-model-summary").textContent(), /0 ready/);
  await page.evaluate(() => { window.infoError = false; }); await reload.click();
  await page.waitForFunction(() => document.querySelector('[data-shared-model="koinos-smart"]').textContent.includes("Available for paid work"));
  assert.equal(await page.evaluate(() => window.providerCalls.some(call => ["chat-completion", "run-chat", "provider-public-start"].includes(call.action))), false);
});
