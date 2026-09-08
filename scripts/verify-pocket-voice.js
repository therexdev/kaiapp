"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert/strict");
const { retryFixtureDownload } = require("./retry-fixture-download");
const dir = process.env.KAI_POCKET_CHECK_DIR || path.join(os.tmpdir(), "kai-pocket-check");
async function check(root = path.join(__dirname, "..")) {
  const { PocketVoice } = require(path.join(root, "electron/pocket-voice"));
  const { Tone } = require(path.join(root, "ui/mascot-pocket"));
  const manager = new PocketVoice({ dir });
  const text = "Hello there, I am your robot friend and I can help you find a movie to watch tonight.";
  const metrics = [];
  try {
    await retryFixtureDownload(() => manager.ensure());
    const cold = performance.now(); await manager.warm("alba"); const coldWarmMs = performance.now() - cold;
    for (const voice of manager.status().voices) {
      for (const pass of voice.id === "alba" ? ["warm", "repeat"] : ["first"]) {
        const chunks = [], starts = [], start = performance.now();
        const stats = await manager.generate({ voice: voice.id, text }, chunk => { starts.push(performance.now() - start); chunks.push(chunk.samples); });
        assert.ok(chunks.length > 2 && starts[0] < stats.totalMs, "Audio is delivered before inference finishes");
        const samples = Float32Array.from(chunks.flatMap(c => Array.from(c)));
        assert.ok(samples.length > 24000 && samples.every(Number.isFinite), "Finite complete voice audio");
        assert.ok(samples.some(x => Math.abs(x) > .02), "Voice must be audible");
        const tone = new Tone(24000, "cute", 9), treated = chunks.map(c => tone.push(c)); treated.push(tone.push(new Float32Array(), true));
        assert.ok(treated[0].length > 0, "Cute effects start before generation ends");
        assert.ok(Math.abs(treated.reduce((n, c) => n + c.length, 0) / samples.length - 1 / 1.08) < .001);
        const audioSeconds = samples.length / 24000;
        metrics.push({ voice: voice.id, pass, coldWarmMs, ...stats, audioSeconds, realTimeFactor: stats.totalMs / 1000 / audioSeconds });
        if (process.env.KAI_MASCOT_QA_DIR) {
          fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
          const wav = array => {
            const b = Buffer.alloc(44 + array.length * 2); b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
            b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(b.length - 44, 40);
            array.forEach((v, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2)); return b;
          };
          fs.writeFileSync(path.join(process.env.KAI_MASCOT_QA_DIR, `pocket-${voice.id}-${pass}.wav`), wav(samples));
          fs.writeFileSync(path.join(process.env.KAI_MASCOT_QA_DIR, `pocket-${voice.id}-${pass}-cute.wav`), wav(Float32Array.from(treated.flatMap(c => Array.from(c)))));
        }
      }
    }
    let first; const received = new Promise(r => { first = r; }); let count = 0;
    const speaking = manager.generate({ voice: "alba", text: text.repeat(3) }, () => { count++; first(); });
    const stopped = assert.rejects(speaking, /stopped/); await received; manager.cancel(); await stopped;
    const before = count; await new Promise(r => setTimeout(r, 100)); assert.equal(count, before); assert.equal(manager.worker, null);
    console.log("PASS: local Pocket inference, early PCM, cute streaming effects, cancellation and process release", JSON.stringify(metrics));
    if (process.env.KAI_MASCOT_QA_DIR) fs.writeFileSync(path.join(process.env.KAI_MASCOT_QA_DIR, "pocket-metrics.json"), JSON.stringify({ platform: process.platform, arch: process.arch, text, metrics }, null, 2));
    return metrics;
  } finally { manager.close(); }
}
module.exports = { check };
if (require.main === module) {
  (async () => {
    if (!process.argv.includes("--packaged")) return check();
    const archives = fs.readdirSync("dist", { recursive: true }).filter(p => path.basename(p) === "app.asar"); assert.ok(archives.length);
    for (const archive of archives) {
      const env = { ...process.env, KAI_POCKET_ASAR: path.resolve("dist", archive), KAI_POCKET_CHECK_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
      const result = require("child_process").spawnSync(require("electron"), [path.join(__dirname, "fixtures/pocket-desktop.js")], { env, stdio: "inherit", timeout: 600000 });
      if (result.error) throw result.error; assert.equal(result.status, 0, "Pocket must stream from the packaged Electron app");
    }
  })().catch(e => { console.error(e); process.exitCode = 1; });
}
