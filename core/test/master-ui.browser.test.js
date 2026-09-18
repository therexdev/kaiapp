"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

// The actual renderer and distribution channels, with no Docker, node RPC or
// transactions. A settings save must survive reload and pause without a password.
test("Master Distribution saves recipients, pauses and exposes Node API controls", { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-ui-"));
  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, onEvent: () => {} });
  const node = core.gateway.koinosNode;
  await node.call("wallet:create", { password: "master fixture password" });
  const address = (await node.call("wallet:status")).address;
  const base = "http://127.0.0.1:" + await core.start();
  const browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const allowed = new Set(["app:info", "wallet:status", "distribution:status", "distribution:configure", "rewards:status", "masterApi:status", "masterApi:configure"]);
  await page.route("**/core/koinos/rpc", async route => {
    const { channel, payload } = route.request().postDataJSON();
    let response;
    try {
      if (!allowed.has(channel)) throw new Error("Outside the offline UI fixture");
      response = { ok: true, data: await node.call(channel, payload) };
    } catch (e) { response = { ok: false, error: e.message }; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.goto(base + "/knode/index.html");
  await page.locator("#di-save").waitFor({ state: "attached" });
  await page.evaluate(() => switchView("distribution"));
  for (const id of ["reburn", "ai", "vhp", "both"]) await page.fill("#di-pct-" + id, "0");
  await page.click("#di-add-recipient");
  await page.fill(".di-recipient-label", "Treasury");
  await page.fill(".di-recipient-address", address);
  await page.fill(".di-recipient-pct", "25");
  await page.check("#di-enabled");
  await page.fill("#di-password", "wrong password");
  await page.click("#di-save");
  await page.waitForFunction(() => document.querySelector("#di-password").value === "");
  assert.equal((await node.call("distribution:status")).config.enabled, false);
  await page.fill("#di-password", "master fixture password");
  await page.click("#di-save");
  await page.waitForFunction(() => S.distribution?.config.enabled === true);
  assert.deepEqual((await node.call("distribution:status")).config.recipients, [{ address, label: "Treasury", pct: 25 }]);
  await page.click("#di-pause");
  await page.waitForFunction(() => !document.querySelector("#di-enabled").checked);
  assert.equal((await node.call("distribution:status")).config.enabled, false);
  await page.reload(); await page.locator("#di-save").waitFor({ state: "attached" });
  await page.evaluate(() => switchView("distribution"));
  assert.equal(await page.inputValue(".di-recipient-address"), address);
  assert.equal(await page.inputValue(".di-recipient-pct"), "25");
  if (process.env.KAI_MASCOT_QA_DIR) {
    fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, "master-distribution.png"), fullPage: true });
  }
  await page.evaluate(() => switchView("master-api"));
  assert.equal(await page.isChecked("#ma-enabled"), false);
  await page.fill("#ma-rpc", "http://127.0.0.1:8085");
  await page.fill("#ma-port", "41111"); await page.click("#ma-save");
  await page.waitForFunction(() => document.querySelector("#ma-status").textContent.includes(":41111/"));
  assert.equal((await node.call("masterApi:status")).config.port, 41111);
  assert.deepEqual(errors, []);
});
