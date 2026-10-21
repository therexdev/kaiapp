"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { navClick } = require("./ui-nav");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("Earn, wallet and account help stay separate; product headings and scroll remain within the page", { skip: !fs.existsSync(CHROMIUM), timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-product-layout-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1040 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en");
    window.koinosShell = { launchMascot: async () => {}, onMascotOpenView() {}, minimize() {}, toggleMaximize() {}, close() {}, onMaximizeChanged() {} };
    window.layoutCalls = [];
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async action => {
      window.layoutCalls.push(action);
      if (action === "status") return { enabled: true, configured: false, mode: "test-deployment" };
      if (action === "chat-info") return { enabled: true, configured: false, blocked: "Not activated" };
      if (action === "credit-status") throw Error("Credit service not activated yet");
      if (action === "purchase-info") return { activation: "unavailable", blocked: "The credit service is not activated yet" };
      if (action === "provider-public-info") return { enabled: false, running: false, state: "unavailable", detail: "Provider setup is not activated yet." };
      if (action === "network-overview") {
        const observedAt = Date.now();
        return { network: { source: "public-scheduler", state: "available", observedAt, validUntil: observedAt + 15000,
          readyProviders: null, providersOnline: 2, waitingRequests: 3, completedToday: null, activityAvailable: false,
          models: [{ id: "koinos-fast", providers: 2, available: true, freeEligible: null, selectable: false }],
          providers: [{ id: "public-provider", model: "koinos-fast", state: "online" }], activity: [] } };
      }
      throw Error("Unexpected test action: " + action);
    } };
  });
  await page.route("**/core/models", route => route.fulfill({ json: { aliases: [{ alias: "fast", label: "Koinos Fast", status: "ready" }], runtime: { runtime: { running: true }, activeAlias: "fast" } } }));
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet: { exists: true, unlocked: true, address: "fixture-wallet" }, worker: { running: false } } }));
  await page.route("**/core/koinos/rpc", route => route.request().postDataJSON().channel === "wallet:summary"
    ? route.fulfill({ json: { ok: true, data: { address: "fixture-wallet", network: "mainnet", tokenSymbol: "KOIN", koin: "149.38227003", vhp: "0", usd: null } } }) : route.continue());
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  await page.locator("#view-chat:not([hidden])").waitFor();
  const capture = async name => {
    if (!process.env.KAI_PRODUCT_QA_DIR) return;
    fs.mkdirSync(process.env.KAI_PRODUCT_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.KAI_PRODUCT_QA_DIR, name + ".png"), animations: "disabled" });
  };
  const headingFits = async view => {
    await page.locator(`#view-${view}:not([hidden])`).waitFor();
    await page.evaluate(async () => Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getTiming().iterations)).map(a => a.finished.catch(() => {}))));
    return page.evaluate(view => {
      const main = document.getElementById("main"), page = document.getElementById("view-" + view);
      const heading = page.querySelector(".product-head").getBoundingClientRect(), bar = main.querySelector(".workspace-header").getBoundingClientRect();
      return main.scrollTop === 0 && page.scrollTop === 0 && heading.top >= bar.bottom && page.scrollWidth <= page.clientWidth && page.getBoundingClientRect().bottom <= innerHeight;
    }, view);
  };
  for (const size of [{ width: 1920, height: 1040 }, { width: 1280, height: 820 }, { width: 780, height: 560 }]) {
    await page.setViewportSize(size);
    await navClick(page, '#nav [data-view="earn"]');
    assert.equal(await headingFits("earn"), true, `Earn heading fits ${size.width}×${size.height}`);
    assert.equal(await page.locator("#view-earn #product-legacy-account").count(), 0);
    assert.equal(await page.locator('#view-earn [data-product-view="network-overview"]').count(), 0);
    assert.equal(await page.locator("#view-earn .product-earn").evaluate(el => getComputedStyle(el).overflowY), "visible");
    assert.ok(await page.locator(".product-provider").evaluate(el => el.getBoundingClientRect().height > 250), "sharing panel keeps its natural height");
    await capture(`earn-${size.width}`);
    await page.locator('.product-sidebar-credits [data-product-view="buy-credits"]').click();
    assert.equal(await headingFits("buy-credits"), true, `Purchase heading fits ${size.width}×${size.height}`);
    await page.waitForFunction(() => document.getElementById("product-wallet-balance").textContent.includes("149.38227003"));
    await capture(`buy-credits-${size.width}`);
    await page.locator("#view-buy-credits").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.locator("#nav-network").click();
    assert.equal(await headingFits("network-overview"), true);
    await page.waitForFunction(() => document.getElementById("product-provider-count").textContent === "2");
    assert.equal(await page.locator("#product-provider-count-label").textContent(), "providers online");
    assert.equal(await page.locator("#product-waiting-count-label").textContent(), "jobs waiting");
    assert.equal(await page.locator("#product-network-completed").isVisible(), false, "unpublished completion metrics are omitted");
    assert.equal(await page.locator("[data-network-model]").count(), 0, "public availability never implies that a billing route is ready");
    assert.equal(await page.locator("#product-network-recent").isVisible(), false, "unpublished activity is omitted");
    await capture(`network-${size.width}`);
    await page.locator('.product-sidebar-credits [data-product-view="buy-credits"]').click();
    assert.equal(await headingFits("buy-credits"), true, "returning after a scroll starts at the heading");
  }
  await page.locator('#view-buy-credits [data-product-action="payment-wallet"]').click();
  await page.locator("#wallet-address").waitFor({ state: "visible" });
  assert.equal(await page.locator("#view-payment-wallet").isVisible(), true);
  assert.equal(await page.inputValue("#wallet-address"), "fixture-wallet");
  assert.equal(await page.locator("#koin-test-payments").isVisible(), false);
  assert.doesNotMatch(await page.locator("#view-payment-wallet").textContent(), /Reserved for requests|Add KOIN|Unused funds stay reserved/);
  await page.locator('.product-sidebar-credits [data-credit-help]').click();
  assert.equal(await page.locator("#view-recovery").isVisible(), true);
  assert.equal(await page.locator("#product-legacy-account").evaluate(el => el.open), true);
  assert.equal(await page.locator("#view-recovery #koin-test-payments").count(), 1, "original recovery controls remain connected to their existing handlers");
  await navClick(page, '#nav [data-view="earn"]');
  assert.equal(await headingFits("earn"), true, "opening old recovery cannot crush Earn");
  assert.equal(await page.locator("#product-legacy-account").isVisible(), false);
  assert.deepEqual(errors, []);
});
