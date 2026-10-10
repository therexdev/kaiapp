"use strict";
// Real renderer, fixture host. Native Electron dialogs/IPC need the manual checklist.
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { createDemoServer } = require("../../electron/compare-fixture-main");
const { createCompareFixtureDemo } = require("../../electron/compare-fixture-demo");
const executablePath = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("Compare fixture renderer: denial, repeated clicks, per-model consent and lifecycle", { skip: !fs.existsSync(executablePath) && "Chromium unavailable; visual/Electron verification not performed" }, async t => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath }); t.after(() => browser.close());
  const server = createDemoServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  let response = 0, reviews = 0;
  const window = { isDestroyed: () => false, isVisible: () => true };
  const service = createCompareFixtureDemo({ getWindow: () => window, dialog: { showMessageBox: async () => { reviews++; return { response }; } } });
  t.after(() => service.dispose());
  const page = await browser.newPage();
  await page.exposeFunction("fixtureCall", async (action, value) => {
    const input = action === "select" ? { models: value } : action === "run" ? { prompt: value } : ["approve", "revoke"].includes(action) ? { model: value } : undefined;
    try { return { ok: true, state: await service[action](input) }; }
    catch (error) { return { ok: false, error: error.message, state: service.status() }; }
  });
  await page.addInitScript(() => { window.compareFixture = Object.fromEntries(["status", "install", "enable", "disable", "uninstall", "select", "approve", "run", "revoke", "stop"].map(action => [action, value => window.fixtureCall(action, value)])); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const waitText = (id, text) => page.waitForFunction(({ id, text }) => {
    const actual = document.getElementById(id).textContent;
    return text === "approved" ? actual.startsWith("approved") : actual.includes(text);
  }, { id, text });
  await page.click("#install"); await waitText("plugin-status", "enabled");
  await page.fill("#prompt", "Fixture comparison"); await page.click("#run"); await waitText("error", "Access denied");
  await page.click("#approve-a"); await waitText("notice", "denied"); assert.equal(service.status().dispatched, 0);
  response = 1;
  await page.evaluate(() => { document.getElementById("approve-a").click(); document.getElementById("approve-a").click(); });
  await waitText("permission-a", "approved"); assert.equal(reviews, 2);
  await page.click("#approve-b"); await waitText("permission-b", "approved");
  await page.evaluate(() => { document.getElementById("run").click(); document.getElementById("run").click(); });
  await waitText("answer-b", "FIXTURE ONLY"); assert.equal(service.status().dispatched, 2);
  await page.selectOption("#model-a", "model:fixture-gamma"); await waitText("label-a", "Gamma"); await waitText("permission-b", "not approved");
  await page.click("#approve-a"); await waitText("permission-a", "approved");
  await page.click("#revoke-a"); await waitText("permission-a", "not approved");
  await page.click("#toggle"); await waitText("plugin-status", "disabled");
  await page.click("#toggle"); await waitText("plugin-status", "enabled");
  await page.click("#stop"); await waitText("notice", "Canceled");
  await page.click("#uninstall"); await waitText("plugin-status", "Not installed");
});
