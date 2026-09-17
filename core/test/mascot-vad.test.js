"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { detectorOptions, SileroCapture } = require("../../ui/mascot-vad");
const { Listener } = require("../../ui/mascot-wake");
const { wakeRequest } = require("../../ui/mascot-client");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("Silero profiles preserve KAI's room sensitivity and pause choices", () => {
  assert.deepEqual(detectorOptions({ sensitivity: "quiet", turnPause: "quick" }), {
    positiveSpeechThreshold: .35, negativeSpeechThreshold: .2, minSpeechMs: 180,
    redemptionMs: 500, preSpeechPadMs: 300, submitUserSpeechOnPause: false,
  });
  assert.deepEqual(detectorOptions({ sensitivity: "balanced", turnPause: "patient" }), {
    positiveSpeechThreshold: .5, negativeSpeechThreshold: .35, minSpeechMs: 240,
    redemptionMs: 1400, preSpeechPadMs: 300, submitUserSpeechOnPause: false,
  });
  assert.deepEqual(detectorOptions({ sensitivity: "tv", turnPause: "patient", guarded: true }), {
    positiveSpeechThreshold: .65, negativeSpeechThreshold: .5, minSpeechMs: 120,
    redemptionMs: 500, preSpeechPadMs: 300, submitUserSpeechOnPause: false,
  });
});

test("Silero reuses KAI's stream and context, serializes pause/flush, and runs one inference lane", async () => {
  const stream = { id: "existing-mic" }, audioContext = { id: "existing-context" };
  const events = [], optionUpdates = []; let options, starts = 0, pauses = 0, destroyed = 0;
  const instance = {
    listening: false,
    setOptions(update) { optionUpdates.push(update); this.options = { ...this.options, ...update }; },
    async start() { starts++; this.listening = true; },
    async pause() {
      pauses++; this.listening = false;
      if (this.options?.submitUserSpeechOnPause) options.onSpeechEnd(new Float32Array([.1, .2]));
    },
    destroy() { destroyed++; },
  };
  const runtime = { MicVAD: { new: async value => { options = value; instance.options = { ...value }; return instance; } } };
  const capture = await SileroCapture.create({ stream, audioContext, runtime, sensitivity: "balanced", turnPause: "patient",
    onSpeechStart: () => events.push("start"), onSpeechEnd: audio => events.push("end:" + audio.length) });
  assert.equal(await options.getStream(), stream);
  assert.equal(await options.resumeStream(), stream);
  assert.equal(options.audioContext, audioContext);
  assert.equal(options.processorType, "AudioWorklet");
  assert.equal(options.startOnLoad, false);
  assert.equal(options.model, "v5");
  const ort = { env: { wasm: {} } }; options.ortConfig(ort);
  assert.equal(ort.env.wasm.numThreads, 1); assert.equal(ort.env.wasm.proxy, false);
  assert.equal(starts, 1);

  options.onSpeechStart(); assert.deepEqual(events, ["start"]);
  await capture.setPaused(true); options.onSpeechStart();
  assert.deepEqual(events, ["start"], "callbacks are closed before the worklet pause completes");
  await capture.setPaused(false); options.onSpeechStart();
  assert.deepEqual(events, ["start", "start"]); assert.equal(starts, 2); assert.equal(pauses, 1);

  capture.configure({ sensitivity: "quiet", turnPause: "quick" });
  assert.equal(capture.threshold, .35);
  assert.equal(optionUpdates.at(-1).redemptionMs, 500);
  await capture.flush();
  assert.equal(events.at(-1), "end:2", "manual send closes exactly the active VAD segment");
  assert.equal(instance.options.submitUserSpeechOnPause, false);
  assert.equal(starts, 3); assert.equal(pauses, 2);
  await capture.destroy(); assert.equal(destroyed, 1); assert.equal(pauses, 3);
});

function browserAudio(t) {
  const prior = new Map(["navigator", "AudioContext", "AudioWorkletNode"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, value] of prior) value ? Object.defineProperty(globalThis, key, value) : delete globalThis[key]; });
  let acquisitions = 0, modules = 0;
  const track = { stop() {}, addEventListener() {}, getCapabilities: () => ({}) };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => { acquisitions++; return stream; } } } });
  class Context {
    constructor() { this.sampleRate = 48000; this.destination = {}; this.audioWorklet = { addModule: async () => { modules++; } }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    async resume() {}
    async close() {}
  }
  class Worklet {
    constructor() { this.port = {}; }
    connect() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: Context });
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: Worklet });
  return { counts: () => ({ acquisitions, modules }) };
}

test("Listener routes Silero's 16 kHz segment through the existing wake and Whisper queue", async t => {
  const audio = browserAudio(t), commands = [], engines = []; let callbacks, destroyed = 0, transcribeRate = 0;
  const capture = { threshold: .5, configure() {}, setPaused: async () => {}, reset: async () => {}, flush: async () => {},
    destroy: async () => { destroyed++; } };
  const listener = new Listener({ wakeRequest, createVAD: async options => { callbacks = options; return capture; },
    transcribe: async (_samples, rate) => { transcribeRate = rate; return { text: "What time is it?" }; },
    onCommand: text => commands.push(text), onState() {}, onError: assert.fail, onEngine: value => engines.push(value) });
  await listener.start({ engaged: true });
  assert.deepEqual(audio.counts(), { acquisitions: 1, modules: 0 }, "Silero uses the acquired stream and no second capture worklet");
  assert.equal(listener.captureMode, "silero-v5"); assert.equal(engines[0].fallback, false);
  callbacks.onSpeechStart(); callbacks.onSpeechRealStart();
  callbacks.onSpeechEnd(new Float32Array(1600).fill(.02));
  await tick(); await tick();
  assert.equal(transcribeRate, 16000); assert.deepEqual(commands, ["What time is it?"]);
  await listener.stop(); assert.equal(destroyed, 1);
});

test("Listener falls back to the calibrated capture worklet when Silero cannot initialize", async t => {
  const audio = browserAudio(t), engines = [];
  const listener = new Listener({ wakeRequest, createVAD: async () => { throw new Error("WASM unsupported"); },
    transcribe: async () => ({ text: "" }), onCommand() {}, onState() {}, onError: assert.fail,
    onEngine: value => engines.push(value) });
  await listener.start();
  assert.deepEqual(audio.counts(), { acquisitions: 1, modules: 1 });
  assert.equal(listener.captureMode, "adaptive-rms"); assert.equal(engines[0].fallback, true);
  assert.match(engines[0].reason, /WASM unsupported/);
  await listener.stop();
});
