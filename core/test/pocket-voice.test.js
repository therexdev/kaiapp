"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { EventEmitter } = require("events");
const { Tone } = require("../../ui/mascot-pocket"), { Queue } = require("../../ui/mascot-speech");
const { PocketVoice, validate } = require("../../electron/pocket-voice");
const tick = () => new Promise(r => setImmediate(r));
test("Pocket character pitch and tempo are continuous and independent of native chunk boundaries", () => {
  const input = Float32Array.from({ length: 48000 }, (_, i) => .4 * Math.sin(2 * Math.PI * 220 * i / 24000));
  for (const tone of ["cute", "kai", "natural"]) for (const pitch of [5, 9, 12]) {
    const whole = new Tone(24000, tone, pitch).push(input, true), stream = new Tone(24000, tone, pitch), parts = [];
    for (let at = 0; at < input.length; at += 1379) parts.push(stream.push(input.subarray(at, at + 1379)));
    parts.push(stream.push(new Float32Array(), true));
    const result = Float32Array.from(parts.flatMap(x => Array.from(x)));
    assert.deepEqual(result, whole, "No chunk seams, dropped samples or duplicated overlap");
    assert.ok(result.every(x => Number.isFinite(x) && Math.abs(x) <= .401));
    let crossings = 0; for (let i = 1; i < result.length; i++) if (result[i - 1] < 0 && result[i] >= 0) crossings++;
    const ratio = tone === "cute" ? 2 ** (pitch / 12) : tone === "kai" ? .9 : 1;
    assert.ok(Math.abs(crossings / (result.length / 24000) - 220 * ratio) < 4);
    const tempo = tone === "cute" ? 1.08 : ratio;
    assert.ok(Math.abs(result.length / input.length - 1 / tempo) < .0001);
    assert.ok(parts[0].length > 0, "Effects produce audio before the sentence ends");
  }
});
test("Queue plays streaming audio before generation finishes, retains one inference, and Stop discards late chunks", async () => {
  let endGeneration, endPlayback, signal, prepares = 0; const played = [];
  const q = new Queue({ prepare: async (text, s) => { prepares++; signal = s; return { text, finished: new Promise(r => { endGeneration = r; }) }; },
    play: value => { played.push(value.text); return new Promise(r => { endPlayback = r; }); }, cancel: () => endPlayback?.(), onState() {}, onError: assert.fail });
  q.enqueue(["First.", "Second."]); await tick(); assert.deepEqual(played, ["First."]); assert.equal(prepares, 1);
  q.stop(); assert.equal(signal.aborted, true); endGeneration(); await tick(); assert.equal(prepares, 1); assert.deepEqual(played, ["First."]);
});
test("Pocket never downloads from status/warm; validates voices, language and text before native inference", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-pocket-")); let downloads = 0, workers = 0;
  const m = new PocketVoice({ dir, download: async () => { downloads++; }, workerFactory: () => { workers++; } });
  t.after(() => { m.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(m.status().available, false); await assert.rejects(m.warm(), /Download/);
  await assert.rejects(m.generate({ voice: "alba", text: "안녕하세요" }), /English/);
  await assert.rejects(m.generate({ voice: "../../secret", text: "Hello" }), /Choose/);
  assert.throws(() => validate({ voice: "alba", text: "x".repeat(1201) }), /sentence/);
  assert.equal(downloads, 0); assert.equal(workers, 0);
});
test("Native stream messages are ordered, bounded, and late worker results cannot revive cancelled speech", async t => {
  let worker, count = 0;
  const m = new PocketVoice({ dir: os.tmpdir(), workerFactory: () => { worker = new EventEmitter(); worker.postMessage = x => { worker.request = x; }; worker.terminate = () => { count++; }; return worker; } });
  m.status = () => ({ available: true }); t.after(() => m.close());
  const chunks = []; const run = m.generate({ voice: "alba", text: "Hello." }, x => chunks.push(x)); const old = worker;
  old.emit("message", { id: old.request.id, rate: 24000, seq: 0, samples: new Float32Array(2400) }); assert.equal(chunks.length, 1);
  const rejected = assert.rejects(run, /stopped/); m.cancel(); await rejected; assert.equal(count, 1);
  old.emit("message", { id: old.request.id, rate: 24000, seq: 1, samples: new Float32Array(2400) }); assert.equal(chunks.length, 1);
  const next = m.generate({ voice: "marius", text: "Another sentence." }, x => chunks.push(x)); const invalid = assert.rejects(next, /invalid audio/);
  worker.emit("message", { id: worker.request.id, rate: 24000, seq: 9, samples: new Float32Array(20) }); await invalid; assert.equal(count, 2);
});
test("Warm-up is shared with generation, native timeout and idle release leave no orphan inference", async t => {
  let worker;
  const m = new PocketVoice({ dir: os.tmpdir(), timeoutMs: 100, idleMs: 30, workerFactory: () => {
    worker = new EventEmitter(); worker.postMessage = x => { worker.request = x; }; worker.terminate = () => { worker.killed = true; }; return worker;
  } }); m.status = () => ({ available: true }); t.after(() => m.close());
  const warm = m.warm(); const generation = m.generate({ voice: "alba", text: "Hi." }); const timedOut = assert.rejects(generation, /too long/); const id = worker.request.id;
  worker.emit("message", { id, done: true }); await warm; await tick(); assert.notEqual(worker.request.id, id);
  await timedOut; assert.equal(worker.killed, true);
  const next = m.warm(); worker.emit("message", { id: worker.request.id, done: true }); await next;
  await new Promise(r => setTimeout(r, 45)); assert.equal(worker.killed, true); assert.equal(m.worker, null);
});
