"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { navClick } = require("./ui-nav");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
const A = require("koilib").Signer.fromSeed("reward-feed-wallet-a").getAddress();
const B = require("koilib").Signer.fromSeed("reward-feed-wallet-b").getAddress();

async function fixture(t, rows = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-reward-feed-ui-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Chicago" }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(({ owner, rows }) => {
    localStorage.setItem("kai-interface-language", "en");
    window.rewardOwner = owner; window.rewardScope = "a".repeat(64); window.rewardRows = rows;
    window.rewardCalls = []; window.rewardError = false; window.rewardCycleFresh = true; window.holdReward = false;
    const model = { id: "koinos-smart", label: "Koinos Smart", installed: true, compatible: true, requiredRamGb: 8 };
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async action => {
      if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "chat-info") return { enabled: true, configured: false, blocked: "Fixture" };
      if (action === "provider-public-info") return { state: "ready", enabled: true, running: true, automatic: true, model, models: [model], modelAvailability: [model],
        selection: { mode: "all", models: [] }, offeredModels: [model.id], detail: "Sharing is on." };
      if (action === "provider-public-status") return { state: "online", label: "ONLINE", model: model.id, detail: "Fresh model readiness confirmed.", validUntil: Date.now() + 15000 };
      if (action === "provider-public-earnings") {
        window.rewardCalls.push({ at: Date.now(), scope: window.rewardScope });
        const value = { walletAddress: window.rewardOwner, scope: window.rewardScope, observedAt: Date.now(),
          lastCycleCheck: window.rewardCycleFresh ? Date.now() : null, payouts: structuredClone(window.rewardRows) };
        const failed = window.rewardError;
        if (window.holdReward) await new Promise(resolve => { window.finishReward = resolve; });
        if (failed) throw Error("fixture transport lost; private diagnostic must not appear");
        return value;
      }
      throw Error("Fixture action unavailable");
    } };
  }, { owner: A, rows });
  await page.route("**/core/models", route => route.fulfill({ json: { aliases: [{ alias: "koinos-smart", label: "Koinos Smart", status: "ready" }], runtime: { runtime: { running: false }, activeAlias: null } } }));
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet: { exists: true, unlocked: false, address: A }, worker: { running: true } } }));
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  await navClick(page, '#nav [data-view="earn"]');
  await page.waitForFunction(() => window.rewardCalls.length > 0);
  await page.clock.pauseAt(new Date());
  return { page, panel: page.locator("#product-provider-rewards"), rows: page.locator(".product-reward-item"), status: page.locator("#product-reward-status") };
}
const payout = (epoch, state, availability = "10000000", work = "2500000") => ({ epoch, state, availability, work });
const advance = (page, ms = 15001) => page.clock.runFor(ms);

test("Earn reward feed loads and updates without clicks, preserves exact amounts and reward-day meaning, and replaces the old cards", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const f = await fixture(t, [payout("20749", "paid"), payout("20751", "pending", "123456789", "1"), payout("20750", "needs_review", "0", "5000000")]);
  const { page, panel, rows } = f;
  await page.waitForFunction(() => document.querySelectorAll(".product-reward-item").length === 3);
  assert.deepEqual(await rows.evaluateAll(list => list.map(row => row.dataset.epoch)), ["20751", "20750", "20749"]);
  assert.match(await rows.first().locator(".product-reward-amount").textContent(), /1\.2345679(?:0)? KOIN/);
  assert.match(await rows.first().locator(".product-reward-state").textContent(), /pending|confirming/i);
  assert.doesNotMatch(await rows.first().locator(".product-reward-state").textContent(), /paid/i);
  assert.match(await panel.textContent(), /UTC/);
  assert.equal(await rows.first().locator(".product-reward-day").textContent(), "Oct 25, 2026", "a UTC reward day must not move to October 24 in the Chicago locale");
  assert.equal(await page.locator('[data-product-action="payouts"]').count(), 0);
  assert.equal(await page.locator("#product-provider-advanced").getAttribute("open"), null);
  assert.equal(await page.locator("#product-provider-reload").isVisible(), false);
  assert.equal(await page.locator("#product-provider-options").isVisible(), false);
  assert.equal(await page.evaluate(() => document.getElementById("product-provider-advanced").compareDocumentPosition(document.getElementById("product-provider-models")) & Node.DOCUMENT_POSITION_PRECEDING), 2);
  const before = await page.evaluate(() => window.rewardCalls.length);
  await page.evaluate(() => {
    window.rewardRows = [...window.rewardRows, { epoch: "20752", state: "paid_elsewhere", availability: "123000000", work: "7000000" }];
    window.rewardRows.find(row => row.epoch === "20751").state = "paid";
  });
  await advance(page);
  await page.waitForFunction(() => document.querySelectorAll(".product-reward-item").length === 4);
  assert.equal(await page.evaluate(() => window.rewardCalls.length), before + 1);
  assert.equal(await rows.first().getAttribute("data-epoch"), "20752");
  assert.equal(await page.locator('.product-reward-item[data-epoch="20751"]').getAttribute("data-state"), "paid");
  assert.equal(await page.locator('.product-reward-item[data-epoch="20751"]').count(), 1, "a state update replaces the same reward record");
  assert.match(await page.locator("#product-reward-updated").textContent(), /\d/);
  // Background legacy status paints must not replace the structured feed.
  await page.evaluate(() => { document.getElementById("koin-payout-summary").textContent = "Old manual earnings summary"; });
  await advance(page, 1);
  assert.equal(await rows.count(), 4); assert.doesNotMatch(await panel.textContent(), /Old manual/);
  await page.evaluate(() => { for (let day = 20740; day < 20749; day++) window.rewardRows.push({ epoch: String(day), state: "paid", availability: "40000000", work: "2500000" }); });
  await advance(page);
  await page.waitForFunction(() => document.querySelectorAll(".product-reward-item").length === 13);
  const feed = page.locator("#product-provider-earnings");
  await feed.evaluate(node => { node.scrollTop = 120; });
  const scroll = await feed.evaluate(node => node.scrollTop);
  assert.ok(scroll > 0, "reward history scrolls inside its bounded box");
  await advance(page);
  assert.equal(await feed.evaluate(node => node.scrollTop), scroll, "an unchanged background refresh preserves the reader's scroll position");
  await feed.evaluate(node => { node.scrollTop = 0; });
  if (process.env.KAI_REWARD_QA_DIR) {
    fs.mkdirSync(process.env.KAI_REWARD_QA_DIR, { recursive: true });
    await page.locator("#view-earn").evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: path.join(process.env.KAI_REWARD_QA_DIR, "earn-rewards-1280.png"), animations: "disabled" });
    await page.setViewportSize({ width: 780, height: 700 });
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.locator("#view-earn").evaluate(node => node.scrollWidth <= node.clientWidth), true);
    await page.screenshot({ path: path.join(process.env.KAI_REWARD_QA_DIR, "earn-rewards-780.png"), animations: "disabled" });
  }
});

test("Reward feed keeps last records during a transient failure, retries automatically, and pauses away from visible Earn", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const { page, rows, panel, status } = await fixture(t, [payout("20751", "paid")]);
  await rows.first().waitFor();
  await page.evaluate(() => { window.rewardError = true; }); await advance(page);
  await page.waitForFunction(() => /retry|interrupted|unavailable/i.test(document.getElementById("product-reward-status").textContent));
  assert.equal(await rows.count(), 1, "a failed refresh must not turn confirmed history into empty history");
  assert.doesNotMatch(await panel.textContent(), /private diagnostic|fixture transport/);
  const failedCount = await page.evaluate(() => window.rewardCalls.length);
  await page.evaluate(() => { window.rewardError = false; window.rewardRows.push({ epoch: "20752", state: "queued", availability: "3000000", work: "0" }); });
  await advance(page, 30001);
  await page.waitForFunction(() => document.querySelectorAll(".product-reward-item").length === 2);
  assert.equal(await page.evaluate(() => window.rewardCalls.length), failedCount + 1);
  await navClick(page, '#nav [data-view="chat"]');
  const offPage = await page.evaluate(() => window.rewardCalls.length);
  await advance(page, 60001);
  assert.equal(await page.evaluate(() => window.rewardCalls.length), offPage, "hidden Earn does not poll");
  await navClick(page, '#nav [data-view="earn"]');
  await page.waitForFunction(previous => window.rewardCalls.length > previous, offPage);
  // Simulate the browser's visibility notification without relying on a test
  // runner's window-manager focus, which varies across native CI platforms.
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  const hidden = await page.evaluate(() => window.rewardCalls.length);
  await advance(page, 60001);
  assert.equal(await page.evaluate(() => window.rewardCalls.length), hidden, "a hidden document does not poll");
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForFunction(previous => window.rewardCalls.length > previous, hidden);
  assert.equal(await rows.count(), 2);
  assert.doesNotMatch(await status.textContent(), /failed|unavailable/i);
});

test("Reward feed shows a genuine empty history and fences delayed responses when the reward identity changes", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const { page, panel, rows } = await fixture(t);
  await page.waitForFunction(() => /no.*reward|reward.*appear|no.*payout/i.test(document.getElementById("product-provider-rewards").textContent));
  assert.equal(await rows.count(), 0);
  await page.evaluate(() => { window.rewardRows = [{ epoch: "20749", state: "paid", availability: "9900000000", work: "0" }]; window.holdReward = true; });
  await advance(page);
  await page.waitForFunction(() => typeof window.finishReward === "function");
  const heldCount = await page.evaluate(() => window.rewardCalls.length);
  await advance(page, 15001);
  assert.equal(await page.evaluate(() => window.rewardCalls.length), heldCount, "a pending refresh cannot dispatch an overlapping request");
  await page.evaluate(owner => {
    window.oldRewardReply = window.finishReward; window.holdReward = false;
    window.rewardOwner = owner; window.rewardScope = "b".repeat(64);
    window.rewardRows = [{ epoch: "20753", state: "pending", availability: "7000000", work: "0" }];
    window.dispatchEvent(new Event("kai-credit-identity-changed"));
  }, B);
  assert.doesNotMatch(await panel.textContent(), /99(?:\.0+)? KOIN/);
  assert.equal(await page.locator("#product-reward-updated").getAttribute("title"), null, "identity reset also clears the old wallet tooltip");
  await page.evaluate(() => window.oldRewardReply());
  await advance(page, 15001);
  await page.waitForFunction(() => document.querySelector('.product-reward-item[data-epoch="20753"]'));
  assert.equal(await rows.count(), 1); assert.equal(await rows.first().getAttribute("data-epoch"), "20753");
  assert.doesNotMatch(await panel.textContent(), /99(?:\.0+)? KOIN/);
  assert.equal(await rows.first().getAttribute("data-state"), "pending");
});
