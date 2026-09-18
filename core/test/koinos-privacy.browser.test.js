"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("enabling Koinos Node opens its real UI without changing Local-Only", { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-node-privacy-"));
  const core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent: () => {} });
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  // Keep the actual gateway, enable switch and UI bootstrap. Only service
  // calls that could reach Docker or public networks are excluded here.
  const node = core.gateway.koinosNode;
  const call = node.call.bind(node), calls = [];
  const local = new Set(["app:info", "wallet:status", "rewards:status"]);
  node.call = async (channel, payload) => {
    calls.push(channel);
    if (!local.has(channel)) throw new Error("Network service unavailable in offline fixture");
    return call(channel, payload);
  };
  const base = "http://127.0.0.1:" + await core.start();
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(base);
  await page.evaluate(() => activateView("settings"));
  await page.locator('#btn-koinos-toggle[aria-checked="false"]').waitFor();
  await page.click("#btn-koinos-toggle");
  const frame = page.frameLocator("#koinos-frame");
  await frame.locator("#version-tag").filter({ hasText: /^v/ }).waitFor({ state: "attached" });
  await frame.locator("#d-status-text").waitFor();
  assert.ok(calls.includes("app:info"));
  assert.ok(calls.includes("wallet:status"));
  assert.doesNotMatch(await frame.locator("body").innerText(), /Failed to start UI/);
  const status = await (await fetch(base + "/core/koinos")).json();
  assert.equal(status.enabled, true);
  assert.equal(status.chainReadsAllowed, true);
  assert.equal(status.privacyMode, "local-only");
  await page.reload();
  await page.evaluate(() => activateView("koinos"));
  await page.frameLocator("#koinos-frame").locator("#version-tag").filter({ hasText: /^v/ }).waitFor({ state: "attached" });
  assert.equal((await (await fetch(base + "/core/koinos")).json()).privacyMode, "local-only");
});
