"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { encodeWav16kMono } = require("../../ui/audio-wav");
const { SmartTurnManager, decodeWav16kMono, WINDOW_SAMPLES } = require("../lib/smart-turn");
const { smartTurnModelPath } = require("../lib/live-senses-assets");
const { Gateway } = require("../lib/gateway");

test("Smart-Turn WAV boundary validates format and retains the newest eight seconds", () => {
  const source = new Float32Array(WINDOW_SAMPLES + 1600);
  source.fill(.25, 0, 1600); source.fill(-.5, 1600);
  const audio = decodeWav16kMono(Buffer.from(encodeWav16kMono(source, 16000)));
  assert.equal(audio.length, WINDOW_SAMPLES);
  assert.ok(Math.abs(audio[0] + .5) < .001);
  assert.throws(() => decodeWav16kMono(Buffer.from("not a wav")), /WAV recording/);
  const wrongRate = Buffer.from(encodeWav16kMono(new Float32Array(160), 16000));
  wrongRate.writeUInt32LE(8000, 24);
  assert.throws(() => decodeWav16kMono(wrongRate), /16 kHz mono 16-bit/);
});

test("Pinned Smart-Turn v3.2 model executes in the isolated local worker", { timeout: 30000 }, async t => {
  const manager = new SmartTurnManager({ modelPath: smartTurnModelPath(), idleMs: 1000 });
  t.after(() => manager.close());
  const status = await manager.warm();
  assert.equal(status.ready, true);
  assert.equal(status.engine, "smart-turn-v3.2");
  const result = await manager.analyze(Buffer.from(encodeWav16kMono(new Float32Array(16000), 16000)));
  assert.equal(result.available, true);
  assert.ok(result.probability >= 0 && result.probability <= 1);
  assert.ok(result.ms >= 0);
});

test("Gateway exposes warm and inference as local control-plane stages", async t => {
  const calls = [];
  const turn = {
    status: () => ({ available: true, ready: false, engine: "smart-turn-v3.2" }),
    warm: async () => ({ available: true, ready: true, engine: "smart-turn-v3.2" }),
    analyze: async wav => { calls.push(wav); return { available: true, engine: "smart-turn-v3.2", probability: .8, ms: 9 }; },
  };
  const gateway = new Gateway({ port: 0, turn });
  const port = await gateway.listen();
  t.after(() => gateway.close());
  let response = await fetch(`http://127.0.0.1:${port}/core/turn`);
  assert.deepEqual(await response.json(), { ok: true, available: true, ready: false, engine: "smart-turn-v3.2" });
  response = await fetch(`http://127.0.0.1:${port}/core/turn/warm`, { method: "POST" });
  assert.equal((await response.json()).ready, true);
  response = await fetch(`http://127.0.0.1:${port}/core/turn`, { method: "POST", body: Buffer.from("WAV") });
  const result = await response.json();
  assert.equal(result.probability, .8);
  assert.equal(calls[0].toString(), "WAV");
});
