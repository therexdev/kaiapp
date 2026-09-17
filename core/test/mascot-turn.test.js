"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Detector, POLICIES, appendAudio, endsMidThought } = require("../../ui/mascot-turn");

test("Turn presets keep acoustic pauses, semantic thresholds and bounded holds together", () => {
  assert.deepEqual(POLICIES.quick, { silenceMs: 500, threshold: .35, holdMs: 2500 });
  assert.deepEqual(POLICIES.natural, { silenceMs: 900, threshold: .5, holdMs: 4000 });
  assert.deepEqual(POLICIES.patient, { silenceMs: 1400, threshold: .65, holdMs: 6000 });
});

test("Smart-Turn audio keeps only the newest eight seconds and resets across sample rates", () => {
  const first = appendAudio(null, new Float32Array(6).map((_, i) => i + 1), 1);
  const second = appendAudio(first, new Float32Array([7, 8, 9, 10]), 1);
  assert.deepEqual([...second.samples], [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([...appendAudio(second, new Float32Array([11, 12]), 2).samples], [11, 12]);
});

test("Semantic decisions use probability plus a narrow mid-thought text guard", () => {
  const detector = new Detector();
  assert.equal(detector.decide({ available: true, probability: .8 }, "Please open my", "natural").complete, false);
  assert.equal(detector.decide({ available: true, probability: .8 }, "What's the duty cycle at", "natural").complete, false);
  assert.equal(detector.decide({ available: true, probability: .8 }, "Please open my calendar.", "natural").complete, true);
  assert.equal(detector.decide({ available: true, probability: .4 }, "Please open my calendar.", "natural").complete, false);
  assert.equal(detector.decide({ available: false }, "Please open my", "natural").complete, true, "silence fallback preserves current behavior");
  assert.equal(endsMidThought("I was wondering, um…"), true);
  assert.equal(endsMidThought("Turn it on."), false);
  assert.equal(endsMidThought("Log me in."), false);
});

test("Detector warms locally, reports inference, and degrades without blocking the turn", async () => {
  const statuses = [], results = [];
  let fail = false;
  const detector = new Detector({
    warm: async () => ({ available: true }),
    encode: audio => audio,
    analyze: async () => {
      if (fail) throw new Error("worker stopped");
      return { available: true, probability: .72, ms: 18 };
    },
    onStatus: value => statuses.push(value.id),
    onResult: value => results.push(value),
  });
  assert.equal(await detector.warm(), true);
  assert.deepEqual(statuses, ["loading", "smart-turn-v3"]);
  assert.deepEqual(await detector.analyze(new Float32Array([.1]), 16000), { available: true, probability: .72, ms: 18 });
  fail = true;
  const fallback = await detector.analyze(new Float32Array([.1]), 16000);
  assert.equal(fallback.available, false);
  assert.equal(statuses.at(-1), "silence");
  assert.equal(results.length, 2);
});
