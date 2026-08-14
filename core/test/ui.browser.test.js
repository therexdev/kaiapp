"use strict";

/*
 * Full product loop in a real Chromium via playwright-core: onboarding
 * (hardware summary -> verified model download with progress) -> streaming
 * chat -> API key lockdown. Core runs for real; llama-server is the fake
 * child-process fixture; the "model CDN" is a local blob server.
 *
 * Skips cleanly when no Chromium is available (e.g. a bare CI runner).
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
const FAKE_BIN = path.join(__dirname, "fixtures", "fake-llama-server");

const available = (() => {
  try {
    require.resolve("playwright-core");
    fs.accessSync(CHROMIUM, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

test("onboarding -> download -> streaming chat -> key lockdown (real browser)", { skip: !available, timeout: 120000 }, async () => {
  const { chromium } = require("playwright-core");

  // "CDN" serving a fake model blob, slowly enough to observe progress.
  const MODEL = crypto.randomBytes(1024 * 1024);
  const MODEL_SHA = crypto.createHash("sha256").update(MODEL).digest("hex");
  const cdn = http.createServer((req, res) => {
    res.writeHead(200, { "content-length": MODEL.length });
    let i = 0;
    const tick = setInterval(() => {
      if (i >= MODEL.length) {
        clearInterval(tick);
        return res.end();
      }
      res.write(MODEL.subarray(i, i + 128 * 1024));
      i += 128 * 1024;
    }, 30);
  });
  await new Promise((r) => cdn.listen(0, "127.0.0.1", r));
  const cdnPort = cdn.address().port;

  // Data dir + catalog pointing at the local CDN.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-ui-"));
  const catalogPath = path.join(dir, "catalog.json");
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      aliases: { "dev-tiny": { label: "Dev Tiny", package: "tiny@1" } },
      packages: {
        "tiny@1": {
          filename: "tiny.gguf",
          url: `http://127.0.0.1:${cdnPort}/tiny.gguf`,
          sha256: MODEL_SHA,
          sizeBytes: MODEL.length,
          runtime: "llamacpp",
        },
      },
    })
  );

  // Real Core, catalog overridden via a ModelManager swap after creation.
  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const { ModelManager } = require("../lib/model-manager");
  const { JsonStore } = require("../lib/store");
  const models = new ModelManager({
    catalogPath,
    modelsDir: path.join(dir, "models"),
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: () => {},
  });
  core.models.catalog = models.catalog;
  core.models.modelsDir = models.modelsDir;
  core.runtime.models = core.models;
  core.gateway.models = core.models;
  const port = await core.start();
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const page = await browser.newPage();
    await page.goto(base);

    // Onboarding is shown; hardware summary fills in.
    await page.waitForSelector("#view-onboarding:not([hidden])");
    await page.waitForFunction(() => document.querySelector("#hw-summary").childElementCount > 0);
    assert.match(await page.textContent("#offer-name"), /Dev Tiny/);

    // Download: progress bar appears, then chat unlocks.
    await page.click("#btn-download");
    await page.waitForSelector("#download-progress:not([hidden])");
    await page.waitForSelector("#view-chat:not([hidden])", { timeout: 60000 });

    // Streaming chat round-trip through Core -> fake llama-server child.
    await page.fill("#input", "hello there");
    await page.click("#btn-send");
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes("Hello from fake llama"))
    );

    // API view: create a key -> /v1 locks down; UI chat lane stays open.
    await page.click('.nav-item[data-view="api"]');
    await page.click("#btn-new-key");
    await page.waitForSelector("#new-key-reveal:not([hidden])");
    const secret = (await page.textContent("#new-key-value")).trim();
    assert.ok(secret.startsWith("kai_sk_"));

    const denied = await fetch(`${base}/v1/models`);
    assert.equal(denied.status, 401, "external surface requires the key now");
    const allowed = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(allowed.status, 200);

    await page.click('.nav-item[data-view="chat"]');
    await page.fill("#input", "still works?");
    await page.click("#btn-send");
    await page.waitForFunction(
      () => document.querySelectorAll(".msg.assistant").length >= 2 && !document.querySelector(".msg.streaming")
    );
    const errors = await page.$$eval(".msg.error", (els) => els.length);
    assert.equal(errors, 0, "built-in chat unaffected by API key lockdown");
  } finally {
    await browser.close();
    await core.stop();
    cdn.close();
  }
});
