"use strict";

const fs = require("fs");
const path = require("path");

const ROUTES = Object.freeze({
  "/live-senses/vad/ort.min.js": "ort.wasm.min.js",
  "/live-senses/vad/ort-wasm-simd-threaded.mjs": "ort-wasm-simd-threaded.mjs",
  "/live-senses/vad/ort-wasm-simd-threaded.wasm": "ort-wasm-simd-threaded.wasm",
  "/live-senses/vad/bundle.min.js": "bundle.min.js",
  "/live-senses/vad/vad.worklet.bundle.min.js": "vad.worklet.bundle.min.js",
  "/live-senses/vad/silero_vad_v5.onnx": "silero_vad_v5.onnx",
});

/**
 * Resolve the local-only browser VAD assets without exposing either
 * node_modules or process.resourcesPath as a browsable directory.
 *
 * In development the three VAD files come from the pinned dev dependency. In
 * an installer electron-builder copies just those files to extraResources,
 * so the package never ships vad-web's second ONNX Runtime dependency. KAI's
 * already-pinned ONNX Runtime supplies the remaining three files.
 */
function liveSensesAssets({ rootDir = path.join(__dirname, "..", ".."), resourcesPath = process.resourcesPath } = {}) {
  const ortEntry = require.resolve("onnxruntime-web/wasm", { paths: [rootDir] });
  const ortDir = path.dirname(ortEntry);
  const packagedVad = resourcesPath ? path.join(resourcesPath, "live-senses", "vad") : "";
  const sourceVad = path.join(rootDir, "node_modules", "@ricky0123", "vad-web", "dist");
  const vadDir = packagedVad && fs.existsSync(path.join(packagedVad, "silero_vad_v5.onnx")) ? packagedVad : sourceVad;
  const assets = new Map();
  for (const [route, name] of Object.entries(ROUTES)) {
    const file = path.join(name.startsWith("ort") ? ortDir : vadDir, name);
    // Missing optional assets must not stop the rest of KAI from starting.
    // The listener reports calibrated fallback mode if Silero cannot load.
    if (fs.existsSync(file)) assets.set(route, file);
  }
  return assets;
}

module.exports = { ROUTES, liveSensesAssets };
