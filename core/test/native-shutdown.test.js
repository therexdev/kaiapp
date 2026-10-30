"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { installShutdown } = require("../../scripts/fixtures/native-shutdown");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitReport(dir, stage) {
  const file = path.join(dir, "shutdown.json"), deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const report = JSON.parse(fs.readFileSync(file, "utf8"));
      if (report.stage === stage) return report;
    }
    await delay(20);
  }
  throw new Error("Missing shutdown stage: " + stage);
}

test("native fixture reports completion only after cleanup resolves, once per request", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-shutdown-"));
  let finish, calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const stop = installShutdown(dir, async progress => {
    calls++; progress("waiting for server");
    await pending;
    return { windows: 0, listening: false };
  });
  t.after(() => { stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await delay(150);
  assert.equal(calls, 0);
  fs.writeFileSync(path.join(dir, "shutdown.request"), "shutdown");
  await waitReport(dir, "waiting for server");
  await delay(250);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "shutdown.json"))).stage, "waiting for server");
  finish();
  assert.deepEqual((await waitReport(dir, "complete")).state, { windows: 0, listening: false });
  await delay(150);
  assert.equal(calls, 1);
});

test("native fixture cleanup failures produce a failure report, never completion", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-shutdown-"));
  const stop = installShutdown(dir, async progress => {
    progress("closing windows");
    throw new Error("window cleanup failed");
  });
  t.after(() => { stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, "shutdown.request"), "shutdown");
  const report = await waitReport(dir, "failed");
  assert.match(report.error, /window cleanup failed/);
  assert.equal(report.state, undefined);
});
