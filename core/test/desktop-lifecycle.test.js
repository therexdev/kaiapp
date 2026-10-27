"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createCleanup, failStartup } = require("../../electron/desktop-lifecycle");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("cleanup starts every callback immediately and preserves independent failures in one settled run", async () => {
  const events = [], errors = [], pending = deferred();
  const synchronous = Error("sync resource failure"), asynchronous = Error("async resource failure");
  const cleanup = createCleanup({ logger: { error: (...args) => errors.push(args) } });
  let reentrant;
  cleanup.add("throws", () => { events.push("throws"); reentrant = cleanup.run(); throw synchronous; });
  cleanup.add("rejects", () => { events.push("rejects"); return pending.promise; });
  cleanup.add("last", () => { events.push("last"); return "closed"; });
  const run = cleanup.run();
  assert.deepEqual(events, ["throws", "rejects", "last"]);
  assert.equal(reentrant, run);
  assert.equal(cleanup.run(), run);
  let settled = false;
  run.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "Async cleanup must be awaited");
  pending.reject(asynchronous);
  assert.deepEqual(await run, [
    { status: "rejected", reason: synchronous },
    { status: "rejected", reason: asynchronous },
    { status: "fulfilled", value: "closed" },
  ]);
  assert.deepEqual(errors.map(entry => entry[1]), [synchronous, asynchronous]);
  assert.equal(cleanup.run(), run);
  assert.deepEqual(events, ["throws", "rejects", "last"]);
  assert.throws(() => cleanup.add("late", () => {}), /already started/);
});

test("a throwing or rejecting logger cannot stop cleanup or create an unhandled rejection", async () => {
  for (const error of [() => { throw Error("logger threw"); }, () => Promise.reject(Error("logger rejected"))]) {
    const cleanup = createCleanup({ logger: { error } });
    let closed = false;
    cleanup.add("failed", () => { throw Error("resource threw"); });
    cleanup.add("remaining", () => { closed = true; });
    const result = await cleanup.run();
    assert.equal(closed, true);
    assert.deepEqual(result.map(entry => entry.status), ["rejected", "fulfilled"]);
  }
});

test("startup failure reports the original error and exits only after async cleanup despite dialog failure", async () => {
  const pending = deferred(), events = [], errors = [], error = Error("cannot start core");
  const cleanup = createCleanup({ logger: { error: (...args) => errors.push(args) } });
  cleanup.add("async resource", () => { events.push("cleanup started"); return pending.promise; });
  const result = failStartup({ app: { exit: code => events.push(["exit", code]) },
    dialog: { showErrorBox: (_title, detail) => { events.push("dialog"); assert.match(detail, /cannot start core/); throw Error("dialog unavailable"); } },
    error, cleanup, logger: { error: (...args) => errors.push(args) }, timeoutMs: 1000 });
  assert.deepEqual(events, ["cleanup started", "dialog"]);
  await Promise.resolve();
  assert.equal(events.some(Array.isArray), false);
  pending.resolve();
  await result;
  assert.deepEqual(events, ["cleanup started", "dialog", ["exit", 1]]);
  assert.equal(errors[0][1], error);
  assert.match(errors[1][0], /show the startup error/);
});

test("startup failure exits after an unexpected cleanup throw or rejection", async () => {
  for (const run of [() => { throw Error("cleanup threw"); }, () => Promise.reject(Error("cleanup rejected"))]) {
    const exits = [], errors = [];
    await failStartup({ app: { exit: code => exits.push(code) }, cleanup: { run }, error: Error("startup"),
      logger: { error: (...args) => errors.push(args) }, timeoutMs: 1000 });
    assert.deepEqual(exits, [1]);
    assert.equal(errors.length, 2);
    assert.match(errors[1][0], /Startup cleanup failed/);
  }
});

test("startup failure has a bounded exit and late cleanup completion cannot exit twice", async () => {
  const pending = deferred(), exits = [], cleanup = createCleanup({ logger: { error() {} } });
  cleanup.add("never settles before deadline", () => pending.promise);
  await failStartup({ app: { exit: code => exits.push(code) }, cleanup, error: Error("startup"),
    logger: { error() {} }, timeoutMs: 15 });
  assert.deepEqual(exits, [1]);
  pending.reject(Error("late cleanup failure"));
  await cleanup.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(exits, [1]);
});

test("a broken Electron exit still terminates a failed startup with a nonzero status", () => {
  const file = require.resolve("../../electron/desktop-lifecycle");
  const child = spawnSync(process.execPath, ["-e", `
    const { failStartup } = require(${JSON.stringify(file)});
    failStartup({ app: { exit() { throw Error("exit unavailable"); } },
      error: Error("startup failure"), logger: { error() {} }, timeoutMs: 100 });
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 1);
});
