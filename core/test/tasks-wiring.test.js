"use strict";

/*
 * Scheduled tasks, wired the way the real app wires them.
 *
 * tasks.test.js injects `runChat` and proves the SCHEDULER is right — the
 * clock, the persistence, the chat it writes. It cannot see the bug this file
 * exists for, because the bug was never in the scheduler: it was one line in
 * core/server.js choosing which door to knock on.
 *
 * The task runner used to POST to the PUBLIC /v1/chat/completions with no
 * credentials. That works only while the user has never created an API key.
 * The moment they create one, `keys.required()` flips true, /v1 demands a
 * bearer token, and every scheduled task starts failing with "Missing or
 * invalid API key. Pass it as: Authorization: Bearer <key>" — an error about
 * the external API, shown for a task the user built in the app and never gave
 * a key to. Creating a key to use the Local API silently broke a feature on
 * the other side of the app.
 *
 * The control plane's /core/chat/completions exists precisely so that cannot
 * happen, and teams and bench already used it. So the property under test is
 * simply: having an API key must not stop the app's own scheduled work.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const FAKE_BIN = path.join(__dirname, "fixtures", "fake-llama-server");

/** A real Core, one model already on disk, the fake engine behind it. */
async function bootCore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-taskwire-"));
  const catalogPath = path.join(dir, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({
    aliases: { "koinos-fast": { label: "Koinos Fast", package: "f@1", minRamGb: 1 } },
    packages: { "f@1": { filename: "f.gguf", url: "http://127.0.0.1:1/x", sha256: "1".repeat(64), sizeBytes: 4096, runtime: "llamacpp" } },
  }));
  const modelsDir = path.join(dir, "models");
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(path.join(modelsDir, "f.gguf"), "x".repeat(4096));

  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const { ModelManager } = require("../lib/model-manager");
  const { JsonStore } = require("../lib/store");
  const swapped = new ModelManager({
    catalogPath, modelsDir,
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: () => {},
  });
  core.models.catalog = swapped.catalog;
  core.models.modelsDir = swapped.modelsDir;
  core.runtime.models = core.models;
  core.gateway.models = core.models;
  await core.start();
  return { dir, core };
}

test("a scheduled task still runs after the user creates an API key", { timeout: 120000 }, async (t) => {
  const { core } = await bootCore();
  t.after(async () => { core.tasks?.stop?.(); core.runtime?.stop?.(); await core.stop?.(); });

  const task = core.tasks.create({
    name: "Morning Checks",
    prompt: "Anything I should know?",
    model: "koinos-fast",
    schedule: { kind: "daily", hour: 9 },
  });

  // The trigger: the user opens the Local API tab and makes themselves a key.
  // Nothing about the task changed; the door it knocks on just grew a lock.
  core.gateway.keys.create({ name: "my local api key" });
  assert.equal(core.gateway.keys.required(), true, "precondition: keys are now enforced on /v1");

  await core.tasks.runNow(task.id);

  const after = core.tasks.list().find((x) => x.id === task.id);
  assert.equal(
    after.lastError, null,
    `the task ran; instead it failed with: ${after.lastError}`,
  );
  assert.doesNotMatch(
    String(after.lastError || ""), /API key/i,
    "and above all it did not fail asking the user for a key they should never need here",
  );
  assert.ok(after.lastChatId, "and the answer landed in a chat, as a task's answer should");
});

test("the public /v1 API is still locked down — the fix must not have opened a hole", { timeout: 120000 }, async (t) => {
  const { core } = await bootCore();
  t.after(async () => { core.tasks?.stop?.(); core.runtime?.stop?.(); await core.stop?.(); });

  core.gateway.keys.create({ name: "my local api key" });
  const port = core.gateway.port;
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "koinos-fast", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r.status, 401, "an unauthenticated external caller is still refused");
  const body = await r.json().catch(() => ({}));
  assert.match(String(body?.error?.message || ""), /API key/i);
});
