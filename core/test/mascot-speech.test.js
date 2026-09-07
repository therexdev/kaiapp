"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { Queue, splitSentence, joinWavs, robotTone, cuteTone, prepareSentence } = require("../../ui/mascot-speech");
const { encodeWav16kMono } = require("../../ui/audio-wav");
const tick = () => new Promise(resolve => setImmediate(resolve));
const wav = (seconds = .5, hz = 220) => encodeWav16kMono(Float32Array.from({ length: seconds * 16000 }, (_, i) => .4 * Math.sin(2 * Math.PI * hz * i / 16000)), 16000);

test("Quick start plays the first complete sentence while preparing the second, without waiting for stream end", async () => {
  const pending = [], played = [], ends = [];
  const q = new Queue({ prepare: text => new Promise(r => pending.push({ text, resolve: r })),
    play: text => { played.push(text); return new Promise(r => ends.push(r)); },
    cancel: () => ends.splice(0).forEach(r => r()), onState() {}, onError: assert.fail });
  q.enqueue(["First complete sentence.", "Second complete sentence."]); await tick();
  pending.shift().resolve("First complete sentence."); await tick();
  assert.deepEqual(played, ["First complete sentence."]);
  assert.equal(pending[0].text, "Second complete sentence.");
  q.stop(); pending.shift().resolve("Never play this."); await tick();
  assert.deepEqual(played, ["First complete sentence."], "Stop discards look-ahead audio");
});

test("Cute voice raises pitch without rushing words, stays bounded, and preserves silence", async () => {
  for (const pitch of [5, 9, 12]) {
    const original = wav(1), changed = cuteTone(original, pitch), view = new DataView(changed);
    const duration = (changed.byteLength - 44) / 32000;
    assert.ok(Math.abs(duration - 1 / 1.08) < .001, "Tempo stays at 1.08 at every pitch");
    assert.equal(view.getUint32(4, true), changed.byteLength - 8);
    assert.equal(view.getUint32(40, true), changed.byteLength - 44);
    let crossings = 0, peak = 0, prior = 0;
    for (let i = 44; i < changed.byteLength; i += 2) {
      const sample = view.getInt16(i, true); if (prior < 0 && sample >= 0) crossings++;
      prior = sample; peak = Math.max(peak, Math.abs(sample));
    }
    assert.ok(Math.abs(crossings / duration - 220 * 2 ** (pitch / 12)) < 4, "Pitch matches the selected character");
    assert.ok(peak > 1000 && peak <= 13108, "Overlap/add and interpolation do not amplify or clip");
    assert.deepEqual(new Uint8Array(await prepareSentence("Hello.", { tone: "cute", pitch, synthesize: async () => original })), new Uint8Array(changed));
  }
  const silence = cuteTone(encodeWav16kMono(new Float32Array(1600), 16000));
  assert.ok(new Uint8Array(silence, 44).every(x => x === 0));
  assert.throws(() => cuteTone(new ArrayBuffer(44)), /unreadable/);
  assert.deepEqual(cuteTone(wav(), NaN), cuteTone(wav(), 9));
});

test("Long sentences finish all inference chunks before any audio is returned; Stop discards the remaining sentence", async () => {
  const text = "We can explore the city at a comfortable pace, " + "with plenty of time to enjoy the food and the views along the way, ".repeat(5) + "before heading home.";
  const chunks = splitSentence(text), pending = [], calls = [];
  assert.ok(chunks.length > 1); assert.ok(chunks.every(s => s.length <= 240)); assert.equal(chunks.join(" "), text);
  let done = false;
  const request = prepareSentence(text, { tone: "natural", synthesize: chunk => { calls.push(chunk); return new Promise(r => pending.push(r)); } }).then(value => { done = true; return value; });
  for (let i = 0; i < chunks.length; i++) {
    assert.equal(done, false); assert.equal(calls.length, i + 1); pending.shift()(wav()); await tick();
  }
  const result = await request;
  assert.equal(new DataView(result).getUint32(40, true), result.byteLength - 44);
  assert.equal((result.byteLength - 44) / 32000, chunks.length * .5);
  const abort = new AbortController(); let complete, count = 0;
  const cancelled = prepareSentence(text, { signal: abort.signal, synthesize: () => { count++; return new Promise(r => { complete = r; }); } });
  const rejected = assert.rejects(cancelled, /abort/i); abort.abort(); complete(wav()); await rejected;
  assert.equal(count, 1, "Cancellation cannot start another synthesis chunk");
});

test("Initial sentence buffer waits for look-ahead, handles a one-sentence reply, and ignores late work after Stop", async () => {
  const pending = [], played = [], ends = [];
  const q = new Queue({ buffer: 2, prepare: text => new Promise(r => pending.push({ text, resolve: r })),
    play: text => { played.push(text); return new Promise(r => ends.push(r)); },
    cancel: () => ends.splice(0).forEach(r => r()), onState() {}, onError: assert.fail });
  q.enqueue(["One.", "Two.", "Three."]); q.end(); await tick();
  pending.shift().resolve("One."); await tick(); assert.deepEqual(played, []);
  pending.shift().resolve("Two."); await tick(); assert.deepEqual(played, ["One."]);
  assert.equal(pending[0].text, "Three.");
  q.stop(); pending.shift().resolve("Three."); await tick(); assert.deepEqual(played, ["One."]);
  q.enqueue(["Just one sentence."]); q.end(); await tick(); pending.shift().resolve("Just one sentence."); await tick();
  assert.equal(played.at(-1), "Just one sentence."); q.stop();
});

test("A model pausing between sentences cannot leave a complete buffered sentence waiting forever", async () => {
  const played = [];
  const q = new Queue({ buffer: 2, bufferWaitMs: 15, prepare: async text => text, play: async text => played.push(text), cancel() {}, onState() {}, onError: assert.fail });
  q.enqueue(["Ready now."]);
  await new Promise(r => setTimeout(r, 35));
  assert.deepEqual(played, ["Ready now."]); q.stop();
});

test("Robot treatment deepens pitch, adds a subtle texture, preserves silence and stays within PCM range", async () => {
  const original = wav(1), changed = robotTone(original), view = new DataView(changed);
  assert.ok(Math.abs((changed.byteLength - 44) / (original.byteLength - 44) - 1 / .9) < .001);
  let crossings = 0, peak = 0, prior = 0;
  for (let i = 44; i < changed.byteLength; i += 2) {
    const sample = view.getInt16(i, true); if (prior < 0 && sample >= 0) crossings++; prior = sample; peak = Math.max(peak, Math.abs(sample));
  }
  const hz = crossings / ((changed.byteLength - 44) / 32000);
  assert.ok(hz > 196 && hz < 200, "220 Hz voice lowers to about 198 Hz");
  assert.ok(peak > 1000 && peak <= 13108);
  const clean = await prepareSentence("Hello.", { tone: "natural", synthesize: async () => original });
  assert.deepEqual(new Uint8Array(clean), new Uint8Array(original), "Original tone remains unprocessed");
  const silence = robotTone(encodeWav16kMono(new Float32Array(1600), 16000));
  assert.ok(new Uint8Array(silence, 44).every(x => x === 0));
  assert.throws(() => robotTone(new ArrayBuffer(44)), /unreadable/);
});

test("Joining chunks removes excess internal silence and rejects malformed or mismatched WAVs", () => {
  const samples = new Float32Array(16000); samples.fill(.1, 4000, 12000);
  const piece = encodeWav16kMono(samples, 16000);
  const joined = joinWavs([piece, piece]);
  assert.ok((joined.byteLength - 44) / 32000 < 1.7, "Trim excessive internal padding");
  assert.throws(() => joinWavs([new ArrayBuffer(4)]), /unreadable/);
  const different = piece.slice(0); new DataView(different).setUint32(24, 24000, true);
  assert.throws(() => joinWavs([piece, different]), /sample rate/);
});
