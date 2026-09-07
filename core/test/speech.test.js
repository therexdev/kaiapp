"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("events");
const { SpeechManager } = require("../lib/speech");
const { Gateway } = require("../lib/gateway");
const os = require("os"), path = require("path");
const tick = () => new Promise(resolve => setImmediate(resolve));
for (const failure of ["message", "error", "exit", "constructor"]) test("Natural voice recovers from native " + failure + " without changing the request", async () => {
  const workers = [], runtimes = [];
  class FakeWorker extends EventEmitter {
    constructor(file, { workerData }) {
      super(); runtimes.push(workerData.runtime);
      if (failure === "constructor" && workerData.runtime === "native") throw new Error("DLL initialization failed");
      workers.push(this);
    }
    postMessage(value) { this.request = value; }
    terminate() { this.terminated = true; return Promise.resolve(); }
  }
  const manager = new SpeechManager({ speechDir: os.tmpdir(), WorkerClass: FakeWorker });
  manager.available = () => true;
  try {
    const pending = manager.generate({ text: "Hello friend", voice: "am_puck" });
    const first = workers[0];
    if (failure === "message") first.emit("message", { id: first.request.id, error: "DLL initialization failed" });
    if (failure === "error") first.emit("error", new Error("DLL initialization failed"));
    if (failure === "exit") first.emit("exit", 1);
    assert.deepEqual(runtimes, ["native", "wasm"]);
    const compatible = workers.at(-1);
    assert.equal(compatible.request.text, "Hello friend"); assert.equal(compatible.request.voice, "am_puck");
    await assert.rejects(manager.generate({ text: "Overlap" }), /busy/);
    if (first !== compatible) {
      assert.equal(first.terminated, true);
      first.emit("message", { id: first.request.id, wav: Buffer.from("obsolete") });
      first.emit("exit", 1);
    }
    compatible.emit("message", { id: compatible.request.id, wav: Buffer.from("recovered") });
    assert.equal((await pending).toString(), "recovered");
    manager.reset();
    const again = manager.generate({ text: "Still here" });
    workers.at(-1).emit("message", { id: workers.at(-1).request.id, wav: Buffer.from("again") });
    await again;
    assert.deepEqual(runtimes, ["native", "wasm", "wasm"], "Remember recovery after idle unload");
  } finally { manager.close(); }
});

test("Compatibility recovery stays cancellable and a second failure exposes a retryable error", async () => {
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor() { super(); workers.push(this); }
    postMessage(value) { this.request = value; }
    terminate() { return Promise.resolve(); }
  }
  const manager = new SpeechManager({ speechDir: os.tmpdir(), WorkerClass: FakeWorker });
  manager.available = () => true;
  try {
    const abort = new AbortController();
    const first = manager.generate({ text: "Hello", signal: abort.signal });
    workers[0].emit("exit", 1);
    const stopped = assert.rejects(first, /cancelled/);
    abort.abort(); await stopped;
    workers[1].emit("error", new Error("late failure"));
    assert.equal(workers.length, 2); assert.equal(manager.worker, null);
    const second = manager.generate({ text: "Try again" });
    const rejected = assert.rejects(second, /downloaded voices will be reused/);
    workers[2].emit("message", { id: workers[2].request.id, error: "C:\\private\\broken.node" });
    await rejected;
    assert.equal(workers.length, 3, "No repeated recovery loop");
    assert.equal(manager.status().available, false); assert.equal(manager.status().modelPresent, true);
    const third = manager.generate({ text: "Retry" });
    workers[3].emit("message", { id: workers[3].request.id, wav: Buffer.from("repaired") });
    await third; assert.equal(manager.status().available, true);
    const last = manager.generate({ text: "Closing" });
    const closed = assert.rejects(last, /shutting down/); manager.close(); await closed;
    workers[3].emit("exit", 1); assert.equal(workers.length, 4);
  } finally { manager.close(); }
});

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
  let cancelled = false, setup = 0, warms = 0;
  const speech = {
    status: () => ({ available: true, voices: [{ id: "af_heart" }] }),
    ensure: async () => { setup++; },
    warm: async () => { warms++; },
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
    assert.equal((await fetch(origin + "/core/speech/warm", { method: "POST", body: "{}" })).status, 200);
    assert.equal(warms, 1); assert.equal(setup, 0, "Warm-up cannot trigger setup/download");
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

test("Voice warm-up reuses installed files, shares one worker, and cancelled waiting speech never starts", async t => {
  const workers = [], requests = []; let downloads = 0;
  class FakeWorker extends EventEmitter {
    constructor() { super(); workers.push(this); }
    postMessage(value) { requests.push(value); }
    terminate() { return Promise.resolve(); }
  }
  const manager = new SpeechManager({ speechDir: os.tmpdir(), WorkerClass: FakeWorker, download: async () => { downloads++; } });
  t.after(() => manager.close()); manager.available = () => false;
  await assert.rejects(manager.warm(), /not set up/); assert.equal(downloads, 0); assert.equal(workers.length, 0);
  manager.available = () => true;
  const warming = manager.warm(); assert.equal(manager.warm(), warming);
  const abort = new AbortController();
  const cancelled = manager.generate({ text: "Do not say this", signal: abort.signal });
  const stopped = assert.rejects(cancelled, /cancelled/); abort.abort(); await stopped;
  const next = manager.generate({ text: "Hello after warm-up" });
  assert.equal(requests.length, 1); assert.equal(requests[0].text, undefined);
  workers[0].emit("message", { id: requests[0].id }); await warming; await tick();
  assert.equal(requests.length, 2); assert.equal(requests[1].text, "Hello after warm-up");
  workers[0].emit("message", { id: requests[1].id, wav: Buffer.from("speech") }); await next;
  await manager.warm(); assert.equal(requests.length, 2); assert.equal(workers.length, 1); assert.equal(downloads, 0);
  manager.reset();
  const closing = manager.warm(), rejected = assert.rejects(closing, /shutting down/);
  manager.close(); await rejected;
});
