"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { Listener, Activity, TURN_PAUSES } = require("../../ui/mascot-wake");
const { wakeRequest } = require("../../ui/mascot-client");
const tick = () => new Promise(r => setImmediate(r));
function fixture(t, options = {}) {
  const commands = [], pending = [], errors = [];
  const listener = new Listener({ wakeRequest, interruptWithWake: true,
    transcribe: () => new Promise(resolve => pending.push(resolve)), onCommand: text => commands.push(text),
    onState() {}, onError: e => errors.push(e), ...options });
  listener.active = true; listener.context = { sampleRate: 16000, close: async () => {} };
  listener.activity = new Activity(16000, { sensitivity: "tv", calibrationMs: 0 }); listener.engage();
  const frames = (count, level = 0) => {
    let job;
    for (let n = 0; n < count; n++) job = listener.frame(new Float32Array(1600).fill(level)) || job;
    return job;
  };
  const say = () => { frames(4, .04); return frames(Math.ceil(TURN_PAUSES[listener.turnPause] / 100)); };
  t.after(() => listener.stop()); return { listener, commands, pending, errors, frames, say };
}
test("Natural pauses keep a two-part question in one recording; Quick and Patient have bounded endpoints", async t => {
  for (const turnPause of Object.keys(TURN_PAUSES)) {
    const f = fixture(t, { turnPause });
    f.frames(4, .04);
    f.frames(Math.ceil(TURN_PAUSES[turnPause] / 100) - 1);
    assert.equal(f.pending.length, 0, "A pause shorter than the preference does not send");
    f.frames(4, .04);
    const job = f.frames(Math.ceil(TURN_PAUSES[turnPause] / 100));
    assert.equal(f.pending.length, 1);
    f.pending.shift()({ text: "What is the weather tomorrow in Seattle?" }); await job;
    assert.deepEqual(f.commands, ["What is the weather tomorrow in Seattle?"]);
  }
});
test("Continuing during transcription joins the question instead of starting and interrupting two replies", async t => {
  const f = fixture(t), first = f.say();
  f.frames(4, .04);
  f.pending.shift()({ text: "What is the weather tomorrow" }); await first;
  assert.deepEqual(f.commands, []); assert.equal(f.listener.pendingTurn.text, "What is the weather tomorrow");
  const second = f.frames(9); f.pending.shift()({ text: "in Seattle?" }); await second;
  assert.deepEqual(f.commands, ["What is the weather tomorrow in Seattle?"]);
  assert.equal(f.listener.pendingTurn, null); assert.deepEqual(f.errors, []);
});
test("A guarded KAI cue stays quick, cancels before a continued question, and cannot authorize movie dialogue on the next reply", async t => {
  let stopped = 0;
  const f = fixture(t, { turnPause: "patient", onEnd: () => { stopped++; f.listener.setResponding(false); f.listener.setPlayback(false); } });
  f.listener.setResponding(true); f.listener.setPlayback(true);
  f.frames(2, .04); const first = f.frames(5);
  assert.equal(f.pending.length, 1, "The name does not wait for Patient's 1.4-second pause");
  f.frames(4, .04);
  f.pending.shift()({ text: "Kai, what is the weather" }); await first;
  assert.equal(stopped, 1); assert.deepEqual(f.commands, []);
  const tail = f.frames(5); f.pending.shift()({ text: "in Seoul?" }); await tail;
  assert.deepEqual(f.commands, ["what is the weather in Seoul?"]);
  f.listener.setResponding(true); f.listener.setPlayback(true);
  f.frames(4, .04); const movie = f.frames(5);
  f.pending.shift()({ text: "Get out of the car right now." }); await movie;
  assert.equal(stopped, 1); assert.equal(f.commands.length, 1);
});
test("Off, pause, settings changes and manual Stop discard a held turn and ignore late recognition", async t => {
  for (const action of ["stop", "pause", "configure", "cancelTurn"]) {
    const f = fixture(t), first = f.say();
    f.frames(4, .04); f.pending.shift()({ text: "Open my" }); await first;
    assert.ok(f.listener.pendingTurn);
    const tail = f.frames(9), finish = f.pending.shift();
    if (action === "pause") f.listener.pause(true);
    else if (action === "configure") f.listener.configure({ sensitivity: "tv", interruptWithWake: true, turnPause: "patient" });
    else await f.listener[action]();
    finish({ text: "pictures folder" }); await tail;
    assert.deepEqual(f.commands, [], action); assert.equal(f.listener.pendingTurn, null);
  }
});
test("Manual send flushes a short pause; overload drops the whole ambiguous turn instead of executing fragments", async t => {
  const f = fixture(t, { turnPause: "patient" });
  f.frames(4, .04); const sent = f.listener.flush();
  f.pending.shift()({ text: "What time is it?" }); await sent;
  assert.deepEqual(f.commands, ["What time is it?"]);
  const first = f.say(), finish = f.pending.shift();
  f.say(); f.say(); f.say();
  finish({ text: "Open the browser" }); await first; await tick();
  assert.equal(f.commands.length, 1); assert.equal(f.listener.queue.length, 0);
  assert.match(f.errors[0].message, /catching up/);
  assert.equal(f.listener.active, true);
});
