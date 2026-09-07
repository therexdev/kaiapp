"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const asar = require("@electron/asar");
const yaml = require("js-yaml");
const { TEST_FEED } = require("../core/lib/release-channel");

const archives = fs.readdirSync("dist", { recursive: true }).filter(p => path.basename(p) === "app.asar");
assert.ok(archives.length, "No packaged app found");
for (const archive of archives) {
  const file = path.join("dist", archive);
  const pkg = JSON.parse(asar.extractFile(file, "package.json"));
  const core = JSON.parse(asar.extractFile(file, "core/package.json"));
  assert.equal(pkg.name, "koinos-ai-test");
  assert.equal(pkg.kaiChannel, "test");
  assert.equal(pkg.version, core.version);
  assert.match(pkg.version, /-test\./);
  // electron-builder creates app-update.yml with an installer target, not
  // --dir. The final installer check (without --preflight) always requires it.
  if (!process.argv.includes("--preflight")) {
    const config = yaml.load(fs.readFileSync(path.join(path.dirname(file), "app-update.yml"), "utf8"));
    assert.equal(config.provider, "generic");
    assert.equal(config.url, TEST_FEED);
    assert.equal(config.channel, "test");
  }
  for (const required of ["electron/providers.js", "electron/provider-http.js", "ui/desktop-providers.js", "electron/mascot.js", "electron/mascot-preload.js", "ui/mascot.html",
    "ui/brand.js", "ui/brand-mark.svg", "ui/kai-character.css", "ui/assets/kai-character.png", "ui/assets/kai-voice-hello.wav", "ui/node-brand.css",
    "ui/mascot.js", "ui/mascot-client.js", "ui/mascot.css", "ui/kai-robot.svg", "ui/mascot-launcher.js",
    "ui/mascot-speech.js", "ui/mascot-wake.js", "ui/mascot-audio-worklet.js", "ui/mascot-tools.js", "ui/app-navigation.js", "core/lib/app-tools.js", "electron/tool-approval.js",
    "electron/desktop-actions.js", "core/lib/speech.js", "core/lib/speech-worker.js", "core/lib/speech-wasm.js", "core/lib/speech-wasm-runtime.mjs", "core/runtimes/kokoro.json"]) {
    try {
      // ASAR's directory walker splits on the host separator. Forward slashes
      // happen to work at one level on Windows, but fail for core/lib/*.js.
      assert.ok(asar.extractFile(file, path.normalize(required)).length > 0, "Missing companion asset: " + required);
    } catch (error) {
      console.error("Package diagnostic:", JSON.stringify({ archive: file, required, sourceExists: fs.existsSync(required),
        related: asar.listPackage(file).filter(p => p.includes("core/lib") || /speech|kokoro/.test(p)).slice(0, 100) }, null, 2));
      throw error;
    }
  }
  for (const asset of ["ort.node.min.js", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
    assert.ok(fs.statSync(path.join(file + ".unpacked", "node_modules/onnxruntime-web/dist", asset)).size > 0, "Missing local compatible voice runtime: " + asset);
  }
  console.log(`Verified ${file}: ${pkg.version}`);
}
