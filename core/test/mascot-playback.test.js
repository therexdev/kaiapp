"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { Clock, wav16 } = require("../../ui/mascot-playback");
const { Queue } = require("../../ui/mascot-speech");
const { Listener } = require("../../ui/mascot-wake");
const { encodeWav16kMono } = require("../../ui/audio-wav");
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeContext {
  constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; this.sources = []; }
  createBuffer(_channels, length, sampleRate) { return { duration: length / sampleRate, copyToChannel() {} }; }
  createBufferSource() {
    const source = { connect() {}, disconnect() {}, start: at => { source.at = at; }, stop: () => { source.stopped = true; } };
    this.sources.push(source); return source;
  }
  resume() { this.state = "running"; return Promise.resolve(); }
  suspend() { this.state = "suspended"; return Promise.resolve(); }
  close() { this.state = "closed"; return Promise.resolve(); }
}

function clockFixture() {
  const context = new FakeContext(), states = []; let pulse;
  const clock = new Clock({ contextFactory: () => context, onState: state => states.push(state), now: () => 10000,
    timer: fn => { pulse = fn; return { unref() {} }; }, clearTimer() {} });
  const advance = seconds => {
    context.currentTime = seconds; pulse?.();
    for (const record of [...clock.records]) if (record.end <= seconds) record.source.onended?.();
    pulse?.();
  };
  return { clock, context, states, advance };
}

test("The turn playback clock schedules native sentences on one gap-free timeline", async () => {
  const f = clockFixture(), samples = new Float32Array(24000);
  const first = f.clock.schedule(samples, 24000, { scope: 17, text: "First." });
  const second = f.clock.schedule(samples, 24000, { scope: 17, text: "Second." });
  assert.equal(first.start, .025); assert.equal(first.end, second.start);
  assert.equal(f.context.sources.length, 2); assert.equal(f.clock.metrics().gaps, 0);
  f.advance(.025); assert.equal((await first.started).cancelled, false);
  assert.ok(f.states.some(state => state.audible && state.text === "First."));
  f.advance(1.025); assert.equal((await first.finished).cancelled, false);
  assert.ok(f.states.some(state => state.audible && state.text === "Second."));
  f.advance(2.025); await second.finished;
  assert.equal(f.clock.snapshot().active, false);
});

test("Playback Stop is scope-safe and resolves scheduled work without reviving it", async () => {
  const f = clockFixture(), item = f.clock.schedule(new Float32Array(8000), 16000, { scope: "turn-a" });
  assert.equal(f.clock.cancel("turn-b"), false); assert.equal(f.clock.snapshot().active, true);
  assert.equal(f.clock.cancel("turn-a"), true);
  assert.equal((await item.started).cancelled, true); assert.equal((await item.finished).cancelled, true);
  assert.equal(f.context.sources[0].stopped, true); assert.equal(f.clock.snapshot().active, false);
});

test("WAV decoding supplies normalized PCM to the shared clock and rejects malformed audio", () => {
  const input = Float32Array.from([0, .5, -.5, .999]), decoded = wav16(encodeWav16kMono(input, 16000));
  assert.equal(decoded.sampleRate, 16000); assert.equal(decoded.samples.length, input.length);
  assert.ok(Math.abs(decoded.samples[1] - .5) < .001); assert.ok(Math.abs(decoded.samples[2] + .5) < .001);
  assert.throws(() => wav16(new ArrayBuffer(44)), /unreadable/);
});

test("The speech queue can schedule the next native sentence before the current one ends", async () => {
  const prepared = [], plays = [], finishes = [];
  const queue = new Queue({ playAhead: true, prepare: text => new Promise(resolve => prepared.push({ text, resolve })),
    play: value => { plays.push(value); return new Promise(resolve => finishes.push(resolve)); }, cancel() {}, onState() {}, onError: assert.fail });
  queue.begin(9); queue.enqueue(["One.", "Two."], 9); queue.end(9); await tick();
  prepared.shift().resolve("audio-one"); await tick(); await tick();
  prepared.shift().resolve("audio-two"); await tick(); await tick();
  assert.deepEqual(plays, ["audio-one", "audio-two"], "the second sentence reaches the shared clock while the first is still audible");
  finishes.splice(0).forEach(resolve => resolve()); await tick();
  assert.equal(queue.playing, false); queue.stop();
});

test("The listener carries the exact speaker clock through the AEC tail", () => {
  const listener = new Listener({ transcribe: async () => ({ text: "" }), wakeRequest: () => null,
    onCommand() {}, onState() {}, onError: assert.fail, interruptWithWake: true });
  listener.active = true; listener.engaged = true; listener.responding = true;
  listener.hearOutput("KAI is describing the current screen.");
  listener.setPlayback({ active: true, audible: true, scope: 44, queuedMs: 800, echoUntil: Date.now() + 1200, gaps: 0 });
  let segment = listener.segmentStart();
  assert.match(segment.echo, /describing/); assert.equal(segment.playback.scope, 44); assert.equal(listener.speakerEchoing(), true);
  listener.setPlayback({ active: false, audible: false, scope: 44, echoUntil: Date.now() + 1200 });
  segment = listener.segmentStart(); assert.match(segment.echo, /describing/, "speaker tail remains echo-marked after the final sample");
  listener.echoUntil = Date.now() - 1; assert.equal(listener.speakerEchoing(), false);
});
