"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("events");
const { SpeechManager } = require("../lib/speech");
const { Gateway } = require("../lib/gateway");
const os = require("os"), path = require("path");
const tick = () => new Promise(resolve => setImmediate(resolve));
test("Natural voice rejects invalid requests, limits inference concurrency, and cancels the worker", async () => {
  let worker, terminated = 0;
  class FakeWorker extends EventEmitter {
    constructor() { super(); worker = this; }
    postMessage(value) { this.request = value; }
    terminate() { terminated++; return Promise.resolve(); }
  }
  const manager = new SpeechManager({ speechDir: path.join(os.tmpdir(), "kai-speech-unit-missing"), WorkerClass: FakeWorker });
  await assert.rejects(manager.generate({ text: "Hello" }), /not set up/);
  manager.available = () => true;
  await assert.rejects(manager.generate({ text: "x".repeat(241) }), /short phrase/);
  await assert.rejects(manager.generate({ text: "Hello", voice: "../../elsewhere" }), /Unknown/);
  const abort = new AbortController();
  const first = manager.generate({ text: "Hello", signal: abort.signal });
  const stopped = assert.rejects(first, /cancelled/);
  await assert.rejects(manager.generate({ text: "Another" }), /busy/);
  const old = worker; abort.abort(); await stopped;
  assert.equal(terminated, 1);
  const second = manager.generate({ text: "Fresh", voice: "am_puck" });
  old.emit("message", { id: old.request.id, wav: Buffer.from("stale") });
  worker.emit("message", { id: worker.request.id, wav: Buffer.from("fresh") });
  assert.equal((await second).toString(), "fresh");
  manager.close(); assert.equal(terminated, 2);
});

test("Natural speech API returns WAV and disconnecting playback cancels pending inference", async () => {
  let cancelled = false, setup = 0;
  const speech = {
    status: () => ({ available: true, voices: [{ id: "af_heart" }] }),
    ensure: async () => { setup++; },
    generate: async ({ text, voice, signal }) => {
      if (text === "slow") return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled")); }, { once: true });
      });
      assert.equal(text, "Hello"); assert.equal(voice, "af_heart"); return Buffer.from("RIFFtest");
    },
  };
  const gateway = new Gateway({ port: 0, speech });
  const port = await gateway.listen(), origin = "http://127.0.0.1:" + port;
  try {
    assert.equal((await (await fetch(origin + "/core/speech")).json()).available, true);
    await fetch(origin + "/core/speech/setup", { method: "POST", body: "{}" }); assert.equal(setup, 1);
    const response = await fetch(origin + "/core/speech", { method: "POST", body: JSON.stringify({ text: "Hello", voice: "af_heart" }) });
    assert.equal(response.headers.get("content-type"), "audio/wav"); assert.equal(await response.text(), "RIFFtest");
    const abort = new AbortController();
    const pending = fetch(origin + "/core/speech", { method: "POST", body: JSON.stringify({ text: "slow" }), signal: abort.signal });
    const stopped = assert.rejects(pending, /abort/i);
    await new Promise(resolve => setTimeout(resolve, 50)); abort.abort(); await stopped;
    for (let i = 0; i < 20 && !cancelled; i++) await tick();
    assert.equal(cancelled, true);
  } finally { await gateway.close(); }
});
