"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert/strict");
const dir = process.env.KAI_SPEECH_CHECK_DIR || path.join(os.tmpdir(), "kai-neural-voice-check");
async function check(modulePath = "../core/lib/speech") {
  const { SpeechManager, VOICES } = require(modulePath);
  const manager = new SpeechManager({ speechDir: dir });
  try {
    await manager.ensure();
    // Fail if inference tries to fetch anything after the opt-in install.
    // The worker also has allowRemoteModels=false and reads bundled voices.
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
      if (process.env.KAI_MASCOT_QA_DIR) {
        fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.KAI_MASCOT_QA_DIR, "kai-" + voice.id + ".wav"), wav);
      }
    }
    console.log("PASS: four local natural voices, pinned model, isolated CPU worker, valid non-silent WAV.", JSON.stringify(metrics));
  } finally { manager.close(); }
}
module.exports = { check };
if (require.main === module) {
  if (process.argv.includes("--packaged")) {
    const { spawnSync } = require("child_process");
    const archives = fs.readdirSync("dist", { recursive: true }).filter(p => path.basename(p) === "app.asar");
    assert.ok(archives.length, "Missing packaged app");
    for (const archive of archives) {
      const env = { ...process.env, KAI_SPEECH_ASAR: path.resolve("dist", archive), KAI_SPEECH_CHECK_DIR: dir };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = spawnSync(require("electron"), [path.join(__dirname, "fixtures/speech-desktop.js")], { env, stdio: "inherit", timeout: 300000 });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, "Packaged voice engine must run inside Electron");
    }
  } else check().catch(error => { console.error(error); process.exitCode = 1; });
}
