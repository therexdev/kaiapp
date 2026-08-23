"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { TaskRunner, computeNext } = require("../lib/tasks");
const { ChatStore } = require("../lib/chats");

function mk(runChat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-tasks-"));
  const events = [];
  const runner = new TaskRunner({
    file: path.join(dir, "tasks.json"),
    chats: new ChatStore(path.join(dir, "chats")),
    runChat,
    onEvent: (e) => events.push(e),
  });
  return { dir, runner, events };
}

test("schedule math: daily and weekly land on the next occurrence, never the past", () => {
  const from = new Date("2026-08-15T10:30:00"); // a Saturday
  const daily = computeNext({ kind: "daily", hour: 9 }, from);
  assert.strictEqual(daily.getHours(), 9);
  assert.strictEqual(daily.getDate(), 16, "9:00 already passed today → tomorrow");

  const dailyLater = computeNext({ kind: "daily", hour: 18 }, from);
  assert.strictEqual(dailyLater.getDate(), 15, "18:00 still ahead today");

  const weekly = computeNext({ kind: "weekly", day: 1, hour: 9 }, from); // next Monday
  assert.strictEqual(weekly.getDay(), 1);
  assert.strictEqual(weekly.getHours(), 9);
  assert.ok(weekly > from);

  assert.strictEqual(computeNext({ kind: "hourly" }, from).getTime(), from.getTime() + 3600e3);
  assert.throws(() => computeNext({ kind: "sometimes" }), /unknown schedule/);
});

test("a due task runs through the injected chat door and lands in chat history", async () => {
  const calls = [];
  const { runner, events } = mk(async ({ model, prompt }) => {
    calls.push({ model, prompt });
    return "the answer";
  });
  const t = runner.create({ name: "Morning brief", prompt: "Summarize my day", model: "dev-tiny", schedule: { kind: "hourly" } });
  assert.ok(new Date(t.nextRunAt) > new Date(), "created tasks schedule into the future");

  // Not due yet → tick is a no-op.
  await runner.tick(new Date());
  assert.strictEqual(calls.length, 0);

  // Due → runs once, advances the clock, saves a chat titled after the task.
  await runner.tick(new Date(Date.now() + 3700e3));
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], { model: "dev-tiny", prompt: "Summarize my day" });
  const chats = runner.chats.list();
  assert.strictEqual(chats.length, 1);
  assert.match(chats[0].title, /Morning brief/);
  const saved = runner.chats.get(chats[0].id);
  assert.strictEqual(saved.messages[1].content, "the answer");
  assert.ok(events.some((e) => e.type === "task:done"), "completion is announced");

  const after = runner.list()[0];
  assert.ok(new Date(after.nextRunAt) > new Date(), "clock advanced past now");
  assert.strictEqual(after.lastError, null);
});

test("disabled tasks never run; re-enabling restarts the clock instead of bursting", async () => {
  const calls = [];
  const { runner } = mk(async () => (calls.push(1), "x"));
  const t = runner.create({ name: "n", prompt: "p", model: "m", schedule: { kind: "hourly" } });
  runner.update(t.id, { enabled: false });
  await runner.tick(new Date(Date.now() + 100 * 3600e3)); // way overdue
  assert.strictEqual(calls.length, 0, "disabled = off");

  runner.update(t.id, { enabled: true });
  await runner.tick(new Date());
  assert.strictEqual(calls.length, 0, "re-enable schedules fresh — no missed-run burst");
});

test("a failing run records the error, still advances, and doesn't kill the runner", async () => {
  const { runner, events } = mk(async () => {
    throw new Error("model unavailable");
  });
  const t = runner.create({ name: "n", prompt: "p", model: "m", schedule: { kind: "hourly" } });
  await runner.tick(new Date(Date.now() + 3700e3));
  const after = runner.list()[0];
  assert.match(after.lastError, /model unavailable/);
  assert.ok(new Date(after.nextRunAt) > new Date(), "failure still advances the clock (no tight loop)");
  assert.ok(events.some((e) => e.type === "task:failed"));
  assert.strictEqual(runner.chats.list().length, 0, "no phantom chat on failure");
  await runner.runNow(t.id); // runNow surfaces the same path without throwing
  assert.match(runner.list()[0].lastError, /model unavailable/);
});

test("tasks persist across a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-tasks-"));
  const file = path.join(dir, "tasks.json");
  const a = new TaskRunner({ file, chats: null, runChat: async () => "", onEvent: () => {} });
  a.create({ name: "keep me", prompt: "p", model: "m", schedule: { kind: "daily", hour: 8 } });
  const b = new TaskRunner({ file, chats: null, runChat: async () => "", onEvent: () => {} });
  assert.strictEqual(b.list().length, 1);
  assert.strictEqual(b.list()[0].name, "keep me");
  assert.strictEqual(b.list()[0].schedule.hour, 8);
});

/* --------------------------------------------------------------------------
 * "I clicked Run now and nothing happened."
 *
 * Nothing was wrong with the run. The Tasks list repaints every 5 seconds, and
 * the only sign a run had started was text the click handler wrote onto the
 * button — which the very next repaint threw away. The row went back to
 * reading "hasn't run yet" while the run was still going, and since the first
 * run of the day also loads the model, that is a minute of the app looking
 * like the click never landed.
 *
 * Feedback that a repaint can destroy is not feedback, so the fact now lives
 * in Core and the UI renders it. That also covers the case the click handler
 * never could: a task firing on its own schedule while someone is watching.
 * ----------------------------------------------------------------------- */
test("a task in flight reports itself as running, and stops when it finishes", async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const { runner, dir } = mk(async () => { await held; return "the answer"; });
  const t = runner.create({ name: "Night", prompt: "anything?", model: "m", schedule: { kind: "daily", hour: 9 } });

  const flag = () => runner.list().find((x) => x.id === t.id).running;
  assert.equal(flag(), false, "idle before anything is asked of it");

  const inFlight = runner.runNow(t.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(flag(), true, "running, and it says so while the answer is still coming");

  release();
  await inFlight;
  assert.equal(flag(), false, "and it stops saying so the moment it is done");

  // Never written to disk: it is a fact about this process, not about the
  // task. Persisted, a crash mid-run would strand a task as "running" forever.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "tasks.json"), "utf8"));
  assert.equal("running" in onDisk.tasks[0], false, "the flag is not persisted");
});

test("a run that fails still clears the running flag", async () => {
  const { runner } = mk(async () => { throw new Error("model is not installed"); });
  const t = runner.create({ name: "Night", prompt: "anything?", model: "gone", schedule: { kind: "daily", hour: 9 } });

  await runner.runNow(t.id);

  const after = runner.list().find((x) => x.id === t.id);
  assert.equal(after.running, false, "a failure must not leave the row stuck on Running…");
  assert.match(after.lastError, /not installed/, "and the reason is kept, to be shown");
});
