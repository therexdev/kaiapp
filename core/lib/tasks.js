"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/*
 * Scheduled tasks (local-first): saved prompts that run on a schedule
 * against a model and drop their answer into chat history. Everything
 * lives in one JSON file in the data dir; the runner ticks once a
 * minute while the core is up. Honest constraint, stated in the UI:
 * tasks run while Koinos AI is running — this is a desktop app, not a
 * cloud.
 *
 * The chat call is injected (`runChat`) so the runner goes through the
 * SAME front door as a user chat — §7 privacy routing, budgets, and the
 * kill switch all apply to a scheduled run exactly as to a typed one.
 */

const KINDS = ["hourly", "every6h", "daily", "weekly"];

/** Next due time strictly after `from` for a schedule. */
function computeNext(schedule, from = new Date()) {
  const s = schedule || {};
  if (s.kind === "hourly") return new Date(from.getTime() + 3600e3);
  if (s.kind === "every6h") return new Date(from.getTime() + 6 * 3600e3);
  const hour = Number.isInteger(s.hour) ? s.hour : 9;
  const d = new Date(from);
  d.setMinutes(0, 0, 0);
  d.setHours(hour);
  if (s.kind === "daily") {
    if (d <= from) d.setDate(d.getDate() + 1);
    return d;
  }
  if (s.kind === "weekly") {
    const day = Number.isInteger(s.day) ? s.day : 1; // 0=Sun … 6=Sat
    while (d.getDay() !== day || d <= from) d.setDate(d.getDate() + 1);
    return d;
  }
  throw new Error(`unknown schedule kind: ${s.kind}`);
}

class TaskRunner {
  constructor({ file, chats, runChat, onEvent }) {
    this.file = file;
    this.chats = chats;
    this.runChat = runChat; // async ({model, prompt}) => assistant text
    this.onEvent = onEvent || (() => {});
    this.tasks = [];
    this._timer = null;
    this._running = false;
    /*
     * Which tasks are running RIGHT NOW. In memory on purpose: it is a fact
     * about this process, not about the task, so it must never be persisted —
     * a crash mid-run would otherwise leave a task marked "running" forever
     * with nothing left alive to finish it.
     */
    this._runningIds = new Set();
    try {
      this.tasks = JSON.parse(fs.readFileSync(file, "utf8")).tasks || [];
    } catch {
      /* first run */
    }
  }

  _persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ tasks: this.tasks }));
  }

  /*
   * Tasks, plus whether each is running at this moment.
   *
   * The UI needs this and cannot infer it. A task's answer takes as long as
   * the model takes, and the first run of the day usually includes loading
   * that model — tens of seconds during which nothing about the stored task
   * changes. Without a flag to render, the list looks exactly as it did
   * before the user pressed anything.
   */
  list() {
    return this.tasks.map((t) => ({ ...t, running: this._runningIds.has(t.id) }));
  }

  create({ name, prompt, model, schedule }) {
    name = String(name || "").trim().slice(0, 60);
    prompt = String(prompt || "").trim().slice(0, 4000);
    if (!name) throw new Error("name required");
    if (!prompt) throw new Error("prompt required");
    if (!model) throw new Error("model required");
    if (!KINDS.includes(schedule?.kind)) throw new Error("bad schedule");
    const t = {
      id: `t${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
      name,
      prompt,
      model: String(model),
      schedule: {
        kind: schedule.kind,
        ...(Number.isInteger(schedule.hour) ? { hour: Math.min(23, Math.max(0, schedule.hour)) } : {}),
        ...(Number.isInteger(schedule.day) ? { day: Math.min(6, Math.max(0, schedule.day)) } : {}),
      },
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: computeNext(schedule).toISOString(),
      lastRunAt: null,
      lastChatId: null,
      lastError: null,
    };
    this.tasks.push(t);
    this._persist();
    return t;
  }

  update(id, patch) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new Error("no such task");
    if (typeof patch.enabled === "boolean") {
      t.enabled = patch.enabled;
      // Re-enabling starts the clock fresh — no burst of missed runs.
      if (t.enabled) t.nextRunAt = computeNext(t.schedule).toISOString();
    }
    this._persist();
    return t;
  }

  remove(id) {
    this.tasks = this.tasks.filter((x) => x.id !== id);
    this._persist();
    return {};
  }

  /** One clock tick: run whatever is due. Serialized — one model slot. */
  async tick(now = new Date()) {
    if (this._running) return; // a long run overlapping the next tick
    this._running = true;
    try {
      for (const t of this.tasks) {
        if (!t.enabled || !t.nextRunAt || new Date(t.nextRunAt) > now) continue;
        await this._run(t);
      }
    } finally {
      this._running = false;
    }
  }

  async runNow(id) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new Error("no such task");
    await this._run(t);
    return t;
  }

  async _run(t) {
    // Advance the clock FIRST so a crashing run can't tight-loop.
    t.nextRunAt = computeNext(t.schedule).toISOString();
    this._runningIds.add(t.id);
    this.onEvent({ type: "task:started", id: t.id, name: t.name });
    try {
      const answer = await this.runChat({ model: t.model, prompt: t.prompt });
      const { id: chatId } = this.chats.save({
        title: `⏰ ${t.name}`,
        messages: [
          { role: "user", content: t.prompt },
          { role: "assistant", content: answer },
        ],
      });
      t.lastRunAt = new Date().toISOString();
      t.lastChatId = chatId;
      t.lastError = null;
      this.onEvent({ type: "task:done", id: t.id, name: t.name, chatId });
    } catch (e) {
      t.lastRunAt = new Date().toISOString();
      t.lastError = String(e.message || e).slice(0, 300);
      this.onEvent({ type: "task:failed", id: t.id, name: t.name, error: t.lastError });
    } finally {
      this._runningIds.delete(t.id);
    }
    this._persist();
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick().catch(() => {}), 60e3);
    this._timer.unref?.();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { TaskRunner, computeNext };
