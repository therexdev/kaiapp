"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert/strict");
const dir = process.env.KAI_SPEECH_CHECK_DIR || path.join(os.tmpdir(), "kai-neural-voice-check");
async function check(modulePath = "../core/lib/speech") {
  const { SpeechManager, VOICES } = require(modulePath);
  const { robotTone, cuteTone, prepareSentence } = require(path.join(path.dirname(require.resolve(modulePath)), "../../ui/mascot-speech"));
  const arrayBuffer = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const manager = new SpeechManager({ speechDir: dir });
  try {
    await manager.ensure();
    assert.equal(manager.status().runtime, process.env.KAI_EXPECT_SPEECH_RUNTIME || "native");
    // Inference uses allowRemoteModels=false and bundled voice embeddings.
    const metrics = [];
    for (const voice of VOICES) {
      const start = Date.now();
      const wav = await manager.generate({ text: "Hey, I'm KAI. Your little robot friend, ready to help.", voice: voice.id });
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.readUInt32LE(24), 24000);
      assert.equal(wav.readUInt32LE(40), wav.length - 44);
      let peak = 0;
      for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
      assert.ok(peak > 1000, "Voice is not silent: " + voice.id);
      assert.ok(wav.length > 48000, "Voice has a complete spoken sample");
      metrics.push({ voice: voice.id, durationSeconds: (wav.length - 44) / 48000, elapsedMs: Date.now() - start, peak });
      const robot = Buffer.from(robotTone(arrayBuffer(wav)));
      assert.equal(robot.readUInt32LE(24), 24000);
      assert.ok(Math.abs((robot.length - 44) / (wav.length - 44) - 1 / .9) < .001);
      const startCute = performance.now(), cute = Buffer.from(cuteTone(arrayBuffer(wav)));
      metrics.at(-1).cuteProcessingMs = Math.round(performance.now() - startCute);
      assert.equal(cute.readUInt32LE(24), 24000);
      assert.equal(cute.readUInt32LE(40), cute.length - 44);
      assert.ok(Math.abs((cute.length - 44) / (wav.length - 44) - 1 / 1.08) < .001, "Cute voice preserves an easy-to-follow tempo");
      let cutePeak = 0;
      for (let i = 44; i < cute.length; i += 2) cutePeak = Math.max(cutePeak, Math.abs(cute.readInt16LE(i)));
      assert.ok(cutePeak > 1000 && cutePeak <= peak + 1, "Character treatment stays audible without clipping");
      if (process.env.KAI_MASCOT_QA_DIR) {
        fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.KAI_MASCOT_QA_DIR, "kai-" + manager.status().runtime + "-" + voice.id + ".wav"), wav);
        fs.writeFileSync(path.join(process.env.KAI_MASCOT_QA_DIR, "kai-robot-" + voice.id + ".wav"), robot);
        fs.writeFileSync(path.join(process.env.KAI_MASCOT_QA_DIR, "kai-cute-" + voice.id + ".wav"), cute);
      }
    }
    assert.equal(manager.status().runtime, process.env.KAI_EXPECT_SPEECH_RUNTIME || "native");
    const sentence = "That sounds like a good plan, and we can take it one step at a time so it stays manageable while leaving room to explore a few new ideas together, with enough time to answer your questions and make adjustments whenever something unexpected comes up along the way.";
    let chunks = 0;
    const joined = await prepareSentence(sentence, { synthesize: async text => {
      assert.ok(text.length <= 240); chunks++;
      return arrayBuffer(await manager.generate({ text, voice: "af_heart" }));
    } });
    assert.ok(chunks > 1, "Exercise the inference limit inside one sentence");
    assert.ok(joined.byteLength > 48000 * 8, "Return the whole spoken sentence in one playable WAV");
    if (process.env.KAI_MASCOT_QA_DIR) fs.writeFileSync(path.join(process.env.KAI_MASCOT_QA_DIR, "kai-buffered-sentence.wav"), Buffer.from(joined));
    console.log("PASS: complete sentence assembled before playback; deeper robot treatment uses the same local voice.");
    console.log("PASS: four local natural voices, pinned model, isolated " + manager.status().runtime + " worker, valid non-silent WAV.", JSON.stringify(metrics));
  } finally { manager.close(); }
}
module.exports = { check };
// Deliberately make ONLY the app's native addon unavailable. This reproduces
// a loader failure even on Windows CI machines with current developer DLLs.
// Always restore the build input, including when a child process fails.
async function withoutNative(root, run) {
  const native = path.join(root, "node_modules/onnxruntime-node/bin/napi-v3", process.platform, process.arch, "onnxruntime_binding.node");
  const saved = native + ".kai-check-disabled";
  assert.ok(fs.existsSync(native), "Expected native addon for failure check: " + native);
  fs.renameSync(native, saved);
  try { await run(); } finally { fs.renameSync(saved, native); }
}
async function main() {
  if (process.argv.includes("--packaged")) {
    const { spawnSync } = require("child_process");
    const archives = fs.readdirSync("dist", { recursive: true }).filter(p => path.basename(p) === "app.asar");
    assert.ok(archives.length, "Missing packaged app");
    for (const archive of archives) {
      const env = { ...process.env, KAI_SPEECH_ASAR: path.resolve("dist", archive), KAI_SPEECH_CHECK_DIR: dir };
      delete env.ELECTRON_RUN_AS_NODE;
      const run = () => {
        const result = spawnSync(require("electron"), [path.join(__dirname, "fixtures/speech-desktop.js")], { env, stdio: "inherit", timeout: 600000 });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, "Packaged voice engine must run inside Electron");
      };
      if (process.argv.includes("--without-native")) {
        env.KAI_EXPECT_SPEECH_RUNTIME = "wasm";
        await withoutNative(env.KAI_SPEECH_ASAR + ".unpacked", run);
      } else run();
    }
  } else if (process.argv.includes("--without-native")) {
    process.env.KAI_EXPECT_SPEECH_RUNTIME = "wasm";
    await withoutNative(path.join(__dirname, ".."), () => check());
  } else await check();
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
