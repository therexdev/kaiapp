"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { navClick } = require("./ui-nav");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-wallet-flow-ui-"));
  const core = await require("../server").createCore({ dataDir: directory, port: 0, onEvent() {} });
  let browser; t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-interface-language", "en"); localStorage.setItem("kai-credit-paid-first", "true"); window.calls = []; window.walletConnected = false; window.allowAuthorize = false;
    window.walletInfo = { state: "wallet-connection-required", detail: "Connect your wallet. No email or password required.", walletReady: true, address: "fixture-wallet", canConnect: true, secureStorage: { available: false }, connected: false };
    window.providerInfo = { state: "authorization-required", detail: "Enable earning once for this device.", walletReady: true, walletLocked: true, canAuthorize: true, deviceAuthorized: false, secureStorage: { available: true }, enabled: false, running: false };
    window.kaiKoinTestBridge = { onProgress: () => () => {}, run: async (action, input) => {
      window.calls.push({ action, input });
      if (action === "wallet-info") return structuredClone(window.walletInfo);
      if (action === "wallet-connect") {
        if (window.cancelConnection) return { state: "cancelled" };
        window.walletConnected = true; window.walletInfo = { ...window.walletInfo, state: "ready", connected: true, sessionOnly: input.sessionOnly, detail: "Wallet connected. Free credits only for this session." };
        return { state: "connected", sessionOnly: input.sessionOnly };
      }
      if (action === "status") return { enabled: true, configured: false };
      if (action === "chat-info") return { enabled: true, configured: true, product: "prepaid-usd-v1", activation: window.walletConnected ? "ready" : "wallet-connection-required", blocked: window.walletConnected ? "" : "Connect your wallet.", freeOnlySession: window.walletConnected, models: [] };
      if (action === "credit-status") {
        if (!window.walletConnected) throw Error("Connect your wallet to check credits.");
        return { product: "prepaid-usd-v1", owner: "fixture-wallet", credits: { unit: "USD-1e-8", available: "4000000", version: "1", purchased: { available: "0" }, free: { state: "available", available: "4000000" } }, purchases: [], usage: [] };
      }
      if (action === "provider-public-info") return structuredClone(window.providerInfo);
      if (action === "provider-public-authorize") {
        if (!window.allowAuthorize) return { state: "cancelled" };
        window.providerInfo = { ...window.providerInfo, state: "ready", deviceAuthorized: true, expiresAt: Date.now() + 86400000 };
        return { state: "authorized" };
      }
      if (action === "provider-public-start") { window.providerInfo = { ...window.providerInfo, enabled: true, running: true, walletLocked: true }; return { state: "running" }; }
      if (action === "provider-public-stop") { window.providerInfo = { ...window.providerInfo, enabled: false, running: false }; return { state: "offline" }; }
      if (action === "provider-public-status") return { state: "online", label: "ONLINE", detail: "Fresh qualification and availability.", validUntil: Date.now() + 15000 };
      throw Error("Unavailable in this fixture");
    } };
  });
  await page.route("**/core/earn", route => route.fulfill({ json: { wallet: { exists: true, unlocked: false, address: "fixture-wallet" }, worker: { running: false } } }));
  await page.goto(`http://127.0.0.1:${await core.start()}`);
  return { page, errors };
}
test("wallet-only credits setup is explicit and a Pi session displays only the service's actual free allowance", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => window.KaiWalletAccess.open());
  const connect = page.locator("#product-wallet-access-connect"), session = page.locator("#product-wallet-access-session");
  await session.waitFor({ state: "visible" });
  assert.equal(await connect.isDisabled(), true, "unprotected storage cannot create durable access");
  assert.equal(await page.evaluate(() => window.calls.filter(x => x.action === "wallet-connect").length), 0, "opening credits never enrolls");
  assert.equal(await page.locator('#view-credits [data-credit-total]').textContent(), "—", "no invented free balance before service response");
  await session.click();
  await page.waitForFunction(() => document.querySelector('#view-credits [data-credit-total]').textContent === "40");
  assert.deepEqual(await page.evaluate(() => window.calls.find(x => x.action === "wallet-connect").input), { sessionOnly: true });
  assert.match(await page.locator("#product-wallet-access-session-note").textContent(), /free credits only.*after closing.*protected storage/i);
  assert.match(await page.locator('#view-credits [data-credit-breakdown]').textContent(), /40 free/);
  assert.equal(await page.locator("#view-settings").isVisible(), false, "wallet connection does not send users to email sign-in");
  assert.equal(await page.locator("#network-paid-first").isChecked(), false, "temporary free-only access overrides but preserves paid-first preference");
  assert.equal(await page.evaluate(() => localStorage.getItem("kai-credit-paid-first")), "true");
  assert.equal(await page.locator("#network-paid-first").isDisabled(), true);
  assert.deepEqual(errors, []);
});
test("temporary Pi access can save its wallet connection after protected storage becomes available", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => window.KaiWalletAccess.open());
  await page.locator("#product-wallet-access-session").click();
  await page.waitForFunction(() => window.walletInfo.connected === true);
  await page.evaluate(async () => {
    window.walletInfo = { ...window.walletInfo, canConnect: true, secureStorage: { available: true } };
    await window.KaiWalletAccess.refresh();
  });
  const connect = page.locator("#product-wallet-access-connect");
  assert.equal(await connect.textContent(), "Save wallet connection"); assert.equal(await connect.isEnabled(), true);
  await page.evaluate(() => { window.cancelConnection = true; }); await connect.click();
  await page.waitForFunction(() => !document.getElementById("product-wallet-access-connect").disabled);
  assert.equal(await page.evaluate(() => window.walletInfo.sessionOnly), true);
  assert.match(await page.locator("#product-wallet-access-detail").textContent(), /cancelled/);
  await page.evaluate(() => { window.cancelConnection = false; }); await connect.click();
  await page.waitForFunction(() => document.getElementById("product-wallet-access-connect").hidden === true);
  assert.equal(await page.locator("#product-wallet-access-connect").isVisible(), false, "connected credits update automatically without a redundant refresh button");
  assert.deepEqual(await page.evaluate(() => window.calls.filter(x => x.action === "wallet-connect").map(x => x.input)),
    [{ sessionOnly: true }, { sessionOnly: false }, { sessionOnly: false }]);
  assert.equal(await page.locator("#product-wallet-access-session-note").isVisible(), false);
  assert.equal(await page.locator("#view-settings").isVisible(), false); assert.deepEqual(errors, []);
});
test("Earn enables a device explicitly, respects Cancel, and stays usable with its reward wallet locked", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const { page, errors } = await fixture(t);
  await navClick(page, '#nav [data-view="earn"]');
  const toggle = page.locator("#product-provider-toggle"), reload = page.locator("#product-provider-reload");
  await page.waitForFunction(() => document.getElementById("product-provider-toggle").textContent === "Unlock to enable earning");
  await toggle.click(); await page.locator("#view-payment-wallet").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => window.calls.some(x => x.action === "provider-public-authorize")), false);
  await page.evaluate(() => { window.providerInfo.walletLocked = false; });
  await navClick(page, '#nav [data-view="earn"]');
  await page.waitForFunction(() => document.getElementById("product-provider-toggle").textContent === "Enable earning");
  await toggle.click();
  await page.waitForFunction(() => !document.getElementById("product-provider-toggle").disabled);
  assert.equal(await page.evaluate(() => window.calls.some(x => x.action === "provider-public-start")), false, "cancelling native review never starts earning");
  await page.evaluate(() => { window.allowAuthorize = true; }); await toggle.click();
  await page.waitForFunction(() => document.getElementById("product-provider-detail").textContent.includes("Wallet locked — earning continues"));
  assert.equal(await toggle.getAttribute("aria-checked"), "true"); assert.equal(await toggle.isEnabled(), true);
  assert.equal(await toggle.evaluate(el => getComputedStyle(el).backgroundColor), "rgb(22, 128, 82)");
  await toggle.click();
  await page.waitForFunction(() => document.getElementById("product-provider-toggle").getAttribute("aria-checked") === "false");
  assert.equal(await toggle.textContent(), "Start earning"); assert.equal(await toggle.isEnabled(), true, "authorized device can restart while wallet stays locked");
  await page.evaluate(() => { window.providerInfo = { ...window.providerInfo, state: "backend-upgrade-required", deviceAuthorized: false, canAuthorize: false, detail: "The server needs the wallet-first update." }; });
  await page.locator("#product-provider-advanced > summary").click();
  await reload.click();
  await page.waitForFunction(() => document.getElementById("product-provider-setup").textContent.includes("server needs"));
  assert.equal(await toggle.isDisabled(), true); assert.doesNotMatch(await page.locator("#product-provider-setup").textContent(), /sign in/i);
  assert.deepEqual(errors, []);
});
