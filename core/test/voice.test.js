"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { encodeWav16kMono, TARGET_RATE } = require("../../ui/audio-wav");
const { VoiceManager, transcribeWav, MAX_WAV_BYTES } = require("../lib/whisper");

const posix = process.platform !== "win32"; // fake engines are shell scripts

/** A fake whisper-cli: prints fixed text (plus stderr chatter) and exits 0. */
function fakeEngine(dir, { text = "HELLO FROM WHISPER", exit = 0 } = {}) {
  const bin = path.join(dir, "whisper-cli");
  fs.writeFileSync(bin, `#!/bin/sh\necho "system_info: fake build" >&2\necho "${text}"\necho ""\nexit ${exit}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("wav encoder: 48k float speech becomes a valid 16k mono 16-bit WAV", () => {
  const inRate = 48000;
  const seconds = 1;
  const f32 = new Float32Array(inRate * seconds);
  for (let i = 0; i < f32.length; i++) f32[i] = Math.sin((i * 2 * Math.PI * 440) / inRate) * 0.5;
  const buf = Buffer.from(encodeWav16kMono(f32, inRate));

  assert.strictEqual(buf.toString("ascii", 0, 4), "RIFF");
  assert.strictEqual(buf.toString("ascii", 8, 12), "WAVE");
  assert.strictEqual(buf.readUInt16LE(20), 1, "PCM format");
  assert.strictEqual(buf.readUInt16LE(22), 1, "mono");
  assert.strictEqual(buf.readUInt32LE(24), TARGET_RATE, "16 kHz");
  assert.strictEqual(buf.readUInt16LE(34), 16, "16-bit");
  const dataLen = buf.readUInt32LE(40);
  assert.strictEqual(dataLen, buf.length - 44, "data chunk spans the rest of the file");
  assert.ok(Math.abs(dataLen / 2 - TARGET_RATE * seconds) <= 2, "one second resamples to ~16000 samples");
  // The tone survives the resample: samples are not silence.
  let peak = 0;
  for (let i = 44; i < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
  assert.ok(peak > 8000, `audible signal survives (peak ${peak})`);
});

test("transcribeWav: returns joined trimmed text from engine stdout", { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-voice-"));
  const bin = fakeEngine(dir, { text: "  hello world  " });
  const wav = path.join(dir, "a.wav");
  fs.writeFileSync(wav, Buffer.from(encodeWav16kMono(new Float32Array(1600), 16000)));
  const text = await transcribeWav({ binPath: bin, modelPath: path.join(dir, "model.bin"), wavPath: wav });
  assert.strictEqual(text, "hello world");
});

test("transcribeWav: engine failure rejects with the stderr tail", { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-voice-"));
  const bin = fakeEngine(dir, { exit: 3 });
  const wav = path.join(dir, "a.wav");
  fs.writeFileSync(wav, "x");
  await assert.rejects(
    () => transcribeWav({ binPath: bin, modelPath: "m", wavPath: wav }),
    /exited 3/
  );
});

test("voice manager: unpinned catalog is not installable; env override makes it available", { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-voice-"));
  const catalogPath = path.join(dir, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({
    whisper: {
      version: "pending",
      builds: { [`${process.platform}-${process.arch}-cpu`]: { url: "PENDING", sha256: "PENDING", sizeBytes: 0, binPath: "PENDING" } },
      models: { "base-en": { filename: "ggml-base.en.bin", url: "https://example.invalid/m.bin", sha256: "PENDING", sizeBytes: 0 } },
    },
  }));
  const { RuntimeProvisioner } = require("../lib/runtime-provisioner");
  const provisioner = new RuntimeProvisioner({ catalogPath, runtimesDir: path.join(dir, "rt"), hardware: {}, onEvent: () => {} });

  // PENDING pins: the UI must not offer setup (fail closed, §27).
  const vm = new VoiceManager({ provisioner, catalogPath, voiceDir: path.join(dir, "voice"), onEvent: () => {} });
  let s = vm.status();
  assert.strictEqual(s.available, false);
  assert.strictEqual(s.installable, false, "unpinned hashes are not installable");

  // Power-user escape hatch: KAI_WHISPER_BIN + KAI_WHISPER_MODEL make voice available.
  const bin = fakeEngine(dir);
  const model = path.join(dir, "model.bin");
  fs.writeFileSync(model, "weights");
  process.env.KAI_WHISPER_BIN = bin;
  process.env.KAI_WHISPER_MODEL = model;
  try {
    s = vm.status();
    assert.strictEqual(s.available, true, "env overrides light voice up");
    const out = await vm.transcribe(Buffer.from(encodeWav16kMono(new Float32Array(1600), 16000)));
    assert.strictEqual(out.text, "HELLO FROM WHISPER");
    assert.ok(out.ms >= 0);
  } finally {
    delete process.env.KAI_WHISPER_BIN;
    delete process.env.KAI_WHISPER_MODEL;
  }
});

test("voice manager: rejects oversized and empty audio", { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-voice-"));
  const bin = fakeEngine(dir);
  const model = path.join(dir, "model.bin");
  fs.writeFileSync(model, "w");
  process.env.KAI_WHISPER_BIN = bin;
  process.env.KAI_WHISPER_MODEL = model;
  try {
    const vm = new VoiceManager({ provisioner: null, catalogPath: path.join(dir, "none.json"), voiceDir: dir, onEvent: () => {} });
    await assert.rejects(() => vm.transcribe(Buffer.alloc(0)), /empty audio/);
    await assert.rejects(() => vm.transcribe(Buffer.alloc(MAX_WAV_BYTES + 1)), /too long/);
  } finally {
    delete process.env.KAI_WHISPER_BIN;
    delete process.env.KAI_WHISPER_MODEL;
  }
});

test("gateway: /core/voice + /core/transcribe round-trip; 503 before setup", { skip: !posix }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-voicegw-"));
  const { Gateway } = require("../lib/gateway");
  const { ApiKeys } = require("../lib/keys");
  const { JsonStore } = require("../lib/store");
  const settings = new JsonStore(path.join(dir, "settings.json"), {});

  // Not set up: transcribe answers 503 with a friendly message.
  const bare = new VoiceManager({ provisioner: null, catalogPath: path.join(dir, "none.json"), voiceDir: dir, onEvent: () => {} });
  const gw = new Gateway({ port: 0, runtime: null, models: null, keys: new ApiKeys(settings), voice: bare });
  const gwPort = await gw.listen();
  try {
    let r = await fetch(`http://127.0.0.1:${gwPort}/core/voice`);
    let j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.available, false);

    r = await fetch(`http://127.0.0.1:${gwPort}/core/transcribe`, { method: "POST", body: Buffer.from("RIFFxxxx") });
    assert.strictEqual(r.status, 503, "voice not set up answers 503");

    // With env overrides, the same endpoint transcribes.
    const bin = fakeEngine(dir, { text: "voice round trip" });
    const model = path.join(dir, "model.bin");
    fs.writeFileSync(model, "w");
    process.env.KAI_WHISPER_BIN = bin;
    process.env.KAI_WHISPER_MODEL = model;
    try {
      r = await fetch(`http://127.0.0.1:${gwPort}/core/transcribe`, {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: Buffer.from(encodeWav16kMono(new Float32Array(1600), 16000)),
      });
      j = await r.json();
      assert.strictEqual(j.ok, true);
      assert.strictEqual(j.text, "voice round trip");
    } finally {
      delete process.env.KAI_WHISPER_BIN;
      delete process.env.KAI_WHISPER_MODEL;
    }
  } finally {
    await gw.close();
  }
});
