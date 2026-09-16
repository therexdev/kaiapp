"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { Session } = require("../../ui/mascot-live");

function fixture() {
  let now = 0, timerId = 0;
  const timers = new Map(), phases = [], events = [];
  const session = new Session({
    clock: () => now,
    setTimer: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimer: id => timers.delete(id),
    onPhase: phase => phases.push(phase),
    onTurn: (event, turn) => events.push({ event, turn }),
  });
  return {
    session, phases, events, timers,
    advance(ms) { now += ms; },
    fire() { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); },
  };
}

test("One turn identity cancels every registered subsystem and rejects late work", () => {
  const f = fixture(), cancelled = [];
  const first = f.session.begin({ source: "voice", expectSpeech: true });
  first.onCancel(() => cancelled.push("model"));
  first.onCancel(() => cancelled.push("tools"));
  first.onCancel(() => cancelled.push("speech"));
  first.mark("first_token");
  const second = f.session.begin({ source: "typed" });
  assert.deepEqual(cancelled, ["model", "tools", "speech"]);
  assert.equal(first.signal.aborted, true);
  assert.equal(first.status, "cancelled");
  assert.equal(first.mark("late_audio"), false);
  assert.equal(first.finishModel(), false);
  assert.equal(f.session.isCurrent(second.id), true);
  assert.equal(f.events.filter(e => e.event === "cancelled").length, 1);
});

test("A spoken turn completes only after both the model and scoped speech drain", () => {
  const f = fixture();
  const turn = f.session.begin({ source: "voice", expectSpeech: true,
    preflight: { captureMs: 800, sttMs: 320, endpointMs: 80 } });
  f.advance(600); turn.mark("first_token");
  f.advance(240); turn.mark("tts_started");
  f.advance(160); turn.mark("playback_started"); turn.setPhase("speaking");
  f.advance(1000); turn.finishModel();
  assert.equal(turn.status, "active", "model completion cannot retire audio that is still playing");
  f.advance(500); turn.finishSpeech();
  assert.equal(turn.status, "completed");
  assert.equal(f.session.current, null);
  const saved = f.session.recent(1)[0];
  assert.deepEqual(saved.metrics, {
    captureMs: 800,
    sttEndpointMs: 400,
    modelFirstTokenMs: 600,
    ttsFirstAudioMs: 400,
    voiceToVoiceMs: 1400,
    totalMs: 2900,
  });
  assert.deepEqual(f.session.summary().voiceToVoice, { samples: 1, p50: 1400, p95: 1400 });
});

test("Stage watchdogs reset on activity and fail one turn with a useful stage", () => {
  const f = fixture(); let cancelled = 0;
  const turn = f.session.begin(); turn.onCancel(() => cancelled++);
  turn.watch("first response", 1000);
  f.advance(500); turn.touch("tool_activity", { name: "web_search" });
  f.fire();
  assert.equal(turn.status, "failed");
  assert.equal(turn.signal.aborted, true);
  assert.equal(cancelled, 1);
  assert.equal(turn.error.code, "KAI_TURN_TIMEOUT");
  assert.equal(turn.error.stage, "first response");
  assert.match(turn.error.message, /first response/);
  assert.equal(f.session.summary().failed, 1);
});

test("Completed turns do not run cancellation hooks and diagnostics contain no prompt text", () => {
  const f = fixture(); let cancelled = false;
  const turn = f.session.begin({ source: "typed", meta: { privatePrompt: "do not retain" } });
  turn.onCancel(() => { cancelled = true; });
  f.advance(10); turn.mark("first_token");
  f.advance(10); turn.finishModel();
  assert.equal(cancelled, false);
  const diagnostics = f.session.diagnostics();
  assert.equal(JSON.stringify(diagnostics.recent()).includes("do not retain"), false);
  assert.equal(diagnostics.summary().completed, 1);
  diagnostics.reset();
  assert.equal(diagnostics.summary().turns, 0);
});

test("Failed-turn diagnostics do not retain provider or tool error text", () => {
  const f = fixture();
  const turn = f.session.begin();
  const error = new Error("private provider response");
  error.code = "UPSTREAM_FAILED"; error.stage = "model";
  turn.fail(error);
  const saved = f.session.recent(1)[0];
  assert.deepEqual(saved.error, { name: "Error", code: "UPSTREAM_FAILED", stage: "model" });
  assert.equal(JSON.stringify(saved).includes("private provider response"), false);
});
