"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Gateway } = require("../lib/gateway");
const { ROUTES, liveSensesAssets } = require("../lib/live-senses-assets");

test("Packaging copies only VAD assets and keeps vad-web's duplicate runtime out of production dependencies", () => {
  const pkg = require("../../package.json");
  assert.equal(pkg.devDependencies["@ricky0123/vad-web"], "0.0.29");
  assert.equal(pkg.dependencies["@ricky0123/vad-web"], undefined);
  assert.deepEqual(pkg.build.extraResources.map(item => item.to), [
    "live-senses/vad/bundle.min.js",
    "live-senses/vad/vad.worklet.bundle.min.js",
    "live-senses/vad/silero_vad_v5.onnx",
    "live-senses/LICENSE.txt",
  ]);
});

test("Live Senses resolves six pinned local assets and never selects vad-web's duplicate ONNX runtime", () => {
  const assets = liveSensesAssets();
  assert.deepEqual([...assets.keys()], Object.keys(ROUTES));
  for (const [route, file] of assets) {
    assert.ok(fs.statSync(file).size > (route.endsWith(".onnx") ? 2_000_000 : 1_000), route);
    if (route.startsWith("/live-senses/vad/ort")) assert.doesNotMatch(file, /@ricky0123[/\\]vad-web[/\\]node_modules/);
  }
});

test("KAI's existing ONNX runtime executes one real Silero v5 frame", async () => {
  const ort = require("onnxruntime-web/wasm");
  ort.env.wasm.numThreads = 1;
  const model = liveSensesAssets().get("/live-senses/vad/silero_vad_v5.onnx");
  const session = await ort.InferenceSession.create(fs.readFileSync(model));
  try {
    const output = await session.run({
      input: new ort.Tensor("float32", new Float32Array(512), [1, 512]),
      state: new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]),
      sr: new ort.Tensor("int64", [16000n]),
    });
    assert.ok(Number.isFinite(Number(output.output.data[0])));
    assert.deepEqual(output.stateN.dims, [2, 1, 128]);
  } finally {
    await session.release();
  }
});

test("Gateway serves only explicitly mapped Live Senses files with browser-safe MIME types", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-live-assets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const assets = new Map();
  for (const name of ["engine.mjs", "engine.wasm", "model.onnx"]) {
    const file = path.join(dir, name); fs.writeFileSync(file, name); assets.set("/live-senses/vad/" + name, file);
  }
  const gateway = new Gateway({ port: 0, staticAssets: assets });
  const port = await gateway.listen();
  t.after(() => gateway.close());
  for (const [route] of assets) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), new RegExp(route.endsWith("mjs") ? "javascript" : route.endsWith("wasm") ? "application/wasm" : "octet-stream"));
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/live-senses/vad/package.json`)).status, 404);
});

const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
test("Chromium compiles the packaged ONNX runtime and Silero v5 model together", { skip: !fs.existsSync(CHROMIUM), timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-live-browser-"));
  fs.copyFileSync(path.join(__dirname, "../../ui/mascot-vad.js"), path.join(dir, "mascot-vad.js"));
  fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; connect-src \'self\'"><script src="mascot-vad.js"></script>');
  const gateway = new Gateway({ port: 0, uiDir: dir, staticAssets: liveSensesAssets() });
  const port = await gateway.listen();
  let browser;
  t.after(async () => { await browser?.close(); await gateway.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  const result = await page.evaluate(async () => {
    const runtime = await window.KaiVAD.loadRuntime();
    const instance = await runtime.MicVAD.new({ model: "v5", startOnLoad: false,
      baseAssetPath: window.KaiVAD.ASSET_BASE, onnxWASMBasePath: window.KaiVAD.ASSET_BASE,
      ortConfig: ort => { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; } });
    return { micVAD: typeof runtime.MicVAD.new, initialized: instance.errored === null };
  });
  assert.deepEqual(result, { micVAD: "function", initialized: true });
});
