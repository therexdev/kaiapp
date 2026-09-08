"use strict";
// Actual Windows Whisper, synthetic speech fixtures, real VAD/wake parser.
// This verifies the engine path and pronunciations, not acoustic room quality.
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert/strict");
const { SpeechManager } = require("../core/lib/speech");
const { VoiceManager } = require("../core/lib/whisper");
const { RuntimeProvisioner } = require("../core/lib/runtime-provisioner");
const { Activity, Listener } = require("../ui/mascot-wake");
const { wakeRequest, folderRequest } = require("../ui/mascot-client");
const { encodeWav16kMono } = require("../ui/audio-wav");
const { retryFixtureDownload } = require("./retry-fixture-download");
async function main() {
  assert.equal(process.platform, "win32", "Run this check on the supported Windows speech-input platform");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-wake-check-"));
  const catalogPath = path.join(__dirname, "../core/runtimes/catalog.json");
  const speech = new SpeechManager({ speechDir: path.join(os.tmpdir(), "kai-neural-voice-check") });
  const voice = new VoiceManager({ catalogPath, voiceDir: path.join(dir, "voice"),
    provisioner: new RuntimeProvisioner({ catalogPath, runtimesDir: path.join(dir, "runtimes"), hardware: {} }) });
  let listener;
  try {
    await retryFixtureDownload(() => speech.ensure()); await retryFixtureDownload(() => voice.ensure());
    const results = [], commands = []; let interruptions = 0;
    listener = new Listener({ wakeRequest, onState() {}, onError: error => { throw error; }, onCommand: text => commands.push(text),
      onEnd: () => { interruptions++; listener.setResponding(false); listener.setPlayback(false); },
      transcribe: async (samples, rate) => {
        const result = await voice.transcribe(Buffer.from(encodeWav16kMono(samples, rate)));
        results.push({ text: result.text, ms: result.ms }); console.log("Whisper:", JSON.stringify(result)); return result;
      } });
    listener.active = true; listener.context = { sampleRate: 16000, close: async () => {} }; listener.activity = new Activity(16000, { sensitivity: "tv" });
    const roomNoise = i => .008 * Math.sin(2 * Math.PI * 120 * i / 16000);
    for (let f = 0; f < 20; f++) listener.frame(Float32Array.from({ length: 1600 }, (_, i) => roomNoise(f * 1600 + i)));
    assert.equal(results.length, 0, "Steady background hum must not trigger Whisper");
    const say = async (text, id, volume = 1, ceiling = 0) => {
      const wav = await speech.generate({ text, voice: id });
      const samples = Float32Array.from({ length: (wav.length - 44) / 2 }, (_, i) => wav.readInt16LE(44 + 2 * i) / 32768 * volume);
      const resampled = Buffer.from(encodeWav16kMono(samples, 24000));
      const audio = Float32Array.from({ length: (resampled.length - 44) / 2 + 16000 }, (_, i) => 44 + 2 * i < resampled.length ? resampled.readInt16LE(44 + 2 * i) / 32768 + roomNoise(i) : roomNoise(i));
      if (ceiling) {
        let peak = 0;
        for (let i = 0; i < audio.length; i += 1600) {
          const frame = audio.slice(i, i + 1600);
          peak = Math.max(peak, Math.sqrt(frame.reduce((sum, x) => sum + x * x, 0) / frame.length));
        }
        for (let i = 0; i < audio.length; i++) audio[i] *= ceiling / peak;
      }
      for (let i = 0; i < audio.length; i += 1600) await listener.frame(audio.slice(i, i + 1600));
    };
    listener.engage();
    await say("We should get out of here before the storm arrives.", "am_puck", 1, .015);
    assert.equal(results.length, 0, "Quieter spoken dialogue in an active conversation must stay below the TV threshold");
    for (const id of ["af_heart", "am_puck"]) {
      listener.endConversation(); commands.length = 0;
      await say("Hey Kai, open my pictures folder.", id);
      assert.ok(commands.some(text => folderRequest(text) === "pictures"), id + " wake and question must be recognized: " + JSON.stringify(results));
    }
    listener.endConversation(); commands.length = 0;
    listener.configure({ sensitivity: "quiet", interruptWithWake: false });
    await say("Hey Kai.", "af_heart", .3);
    assert.equal(listener.engaged, true, "Quiet wake phrase must arm conversation: " + JSON.stringify(results));
    await say("What should I pack for that trip?", "af_heart");
    assert.ok(commands.some(text => /pack/i.test(text)), "Follow-up must not need the wake phrase again");
    listener.configure({ sensitivity: "tv", interruptWithWake: true });
    listener.setResponding(true); listener.setPlayback(true); commands.length = 0;
    const beforeDialogue = results.length;
    await say("Get out of the car right now.", "am_puck");
    assert.ok(results.length > beforeDialogue, "Loud dialogue reached the real recognizer");
    assert.equal(commands.length, 0, "Recognized loud background dialogue cannot interrupt a guarded reply");
    await say("Kai, open my pictures folder.", "af_heart");
    // Real Whisper can hear "open" as "opened". This check concerns the name
    // cue and retained question, not turning an ambiguous verb into an action.
    // Exact folder matching/approval remains covered above and in unit tests.
    assert.ok(commands.some(text => /pictures/i.test(text) && !/^kai\b/i.test(text)), "A bare KAI cue must interrupt and retain the following words: " + JSON.stringify(results));
    for (const id of ["af_heart", "am_puck"]) {
      listener.setResponding(false); listener.setResponding(true); listener.setPlayback(true);
      const before = interruptions;
      await say("Kai.", id);
      assert.equal(interruptions, before + 1, "A single spoken KAI must stop the reply: " + id + " " + JSON.stringify(results));
      assert.equal(listener.engaged, true);
    }
    commands.length = 0;
    await say("What should I pack for that trip?", "af_heart");
    assert.ok(commands.some(text => /pack/i.test(text)), "The question after a KAI interruption needs no name");
    console.log("PASS: real Windows Whisper recognizes KAI-only interruptions from two voices, ongoing follow-ups, and rejects background dialogue.");
  } finally {
    await listener?.stop(); speech.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
