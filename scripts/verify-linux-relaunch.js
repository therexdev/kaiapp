"use strict";

// Run under xvfb-run on Linux CI. The Ozone headless backend also supports
// this no-window fixture when a display server is unavailable locally.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process"), { setTimeout: delay } = require("node:timers/promises");
const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";

async function main() {
  if (process.platform !== "linux") throw Error("Run the native Linux relaunch check on Linux");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-linux-relaunch-")), children = [], replacements = [];
  const electron = require("electron"), fixture = path.join(__dirname, "fixtures/linux-relaunch-electron.js");
  const flags = ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", ...(!process.env.DISPLAY ? ["--ozone-platform=headless"] : [])];
  const exists = pid => {
    try {
      process.kill(pid, 0);
      // The relaunched process is no longer our direct child. Container PID 1
      // may retain its zombie briefly; it has exited and owns no profile lock.
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    } catch (error) { if (["ESRCH", "ENOENT"].includes(error.code)) return false; throw error; }
  };
  const wait = async (ready, description, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (!ready()) {
      if (Date.now() >= deadline) throw Error(description + " timed out\n" + children.map(child => child.output).join("\n"));
      await delay(20);
    }
  };
  const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
  function scenario(name) {
    const folder = path.join(root, name); fs.mkdirSync(folder); fs.mkdirSync(path.join(folder, "app-data"));
    const config = { root: folder, releaseChannel: path.resolve(__dirname, "../core/lib/release-channel.js"),
      updateRestart: path.resolve(__dirname, "../electron/update-restart.js"), lifecycle: path.resolve(__dirname, "../electron/desktop-lifecycle.js"),
      originalExecutable: path.join(folder, "Koinos AI Alpha old.AppImage"), replacementExecutable: path.join(folder, "Koinos AI Alpha new.AppImage") };
    const file = path.join(folder, "config.json");
    const launcher = role => "#!/bin/sh\ntest -f " + shellQuote(file) + " || exit 0\nexport KAI_LINUX_RELAUNCH_LAUNCHER=" + shellQuote(role) + "\nexec " + [electron, ...flags, fixture].map(shellQuote).join(" ") + "\n";
    fs.writeFileSync(config.originalExecutable, launcher("original"), { mode: 0o700 });
    fs.writeFileSync(config.replacementExecutable, launcher("replacement"), { mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(config));
    return { ...config, file, result: name => path.join(folder, name + ".json") };
  }
  function launch(config, role, probe) {
    const env = { ...process.env, KAI_LINUX_RELAUNCH_CONFIG: config.file, KAI_LINUX_RELAUNCH_ROLE: role,
      ...(probe ? { KAI_LINUX_RELAUNCH_PROBE: probe } : {}) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [...flags, fixture], { env, stdio: ["ignore", "pipe", "pipe"] });
    const record = { child, output: "", exited: false, code: null }; children.push(record);
    child.stdout.on("data", chunk => { record.output = (record.output + chunk).slice(-8000); });
    child.stderr.on("data", chunk => { record.output = (record.output + chunk).slice(-8000); });
    child.on("error", error => { record.error = error; });
    child.on("exit", code => { record.exited = true; record.code = code; });
    return record;
  }
  async function result(config, name, child) {
    await wait(() => {
      if (child?.error) throw child.error;
      if (fs.existsSync(config.result(name))) return true;
      if (child?.exited) throw Error(name + " exited before reporting: " + child.output);
      return false;
    }, name);
    return read(config.result(name));
  }
  async function blockedProbe(config, name) {
    const child = launch(config, "probe", name), value = await result(config, name, child);
    assert.equal(value.locked, false, "a competing process must not acquire the shared profile");
    await wait(() => child.exited, "blocked probe exit"); assert.equal(child.code, 0, child.output);
  }
  try {
    const update = scenario("update with spaces"), original = launch(update, "update"), first = await result(update, "update", original);
    assert.equal(first.locked, true);
    await blockedProbe(update, "initial-contender");
    fs.writeFileSync(path.join(update.root, "restart"), "restart");
    await result(update, "draining", original);
    assert.equal(original.exited, false, "the original remains alive during cleanup");
    assert.equal(fs.existsSync(update.result("replacement")), false, "the replacement must not start while cleanup holds the lock");
    await blockedProbe(update, "draining-contender");
    assert.equal(original.exited, false, "the original retains its lock until the harness releases cleanup");
    assert.equal(fs.existsSync(update.result("replacement")), false, "even a slow contender cannot race a fixed cleanup timer");
    fs.writeFileSync(path.join(update.root, "finish-cleanup"), "finish");
    const restarted = await result(update, "restart-result", original);
    assert.equal(restarted.installs, 1, "duplicate requests must not queue multiple installs");
    assert.ok(restarted.results.every(value => value.state === "restarting"));
    await wait(() => original.exited, "original process exit"); assert.equal(original.code, 0, original.output);
    const next = await result(update, "replacement"); replacements.push({ config: update, role: "replacement", pid: next.pid });
    assert.equal(next.locked, true); assert.equal(next.profile, first.profile); assert.notEqual(next.pid, first.pid);
    assert.equal(next.launcher, "replacement", "the renamed executable path, including spaces, is used for relaunch");
    const events = fs.readFileSync(path.join(update.root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const cleanup = events.findIndex(event => event.name === "cleanup-finished"), replacement = events.findIndex(event => event.role === "replacement" && event.name === "lock-result");
    assert.ok(cleanup >= 0 && replacement > cleanup, "the replacement acquires the profile only after cleanup");
    assert.equal(events.filter(event => event.role === "replacement" && event.name === "lock-result").length, 1);
    fs.writeFileSync(path.join(update.root, "stop-replacement"), "stop");
    await wait(() => !exists(next.pid), "replacement process exit");

    const failure = scenario("startup failure"), failing = launch(failure, "failure"), failed = await result(failure, "failure", failing);
    assert.equal(failed.locked, true);
    await wait(() => failing.exited, "failed startup process exit"); assert.notEqual(failing.code, 0, "startup failure must exit nonzero");
    const failureEvents = fs.readFileSync(path.join(failure.root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(failureEvents.filter(event => event.name === "throwing-cleanup").length, 1);
    assert.equal(failureEvents.filter(event => event.name === "failure-cleanup-finished").length, 1, "async cleanup still completes when another cleanup or the dialog throws");
    const reopened = launch(failure, "reopen"), recovered = await result(failure, "reopen", reopened);
    assert.equal(recovered.locked, true, "failed startup must release the shared profile for the next launch");
    fs.writeFileSync(path.join(failure.root, "stop-reopen"), "stop");
    await wait(() => reopened.exited, "reopened process exit"); assert.equal(reopened.code, 0, reopened.output);
    console.log("PASS: native Linux update waits for exit, preserves the shared singleton, handles spaces in the executable path, and startup failure releases the profile after cleanup.");
  } finally {
    for (const record of children) if (!record.exited) record.child.kill("SIGTERM");
    for (const record of replacements) {
      fs.writeFileSync(path.join(record.config.root, "stop-" + record.role), "stop");
      if (exists(record.pid)) process.kill(record.pid, "SIGTERM");
    }
    await wait(() => children.every(child => child.exited), "fixture child cleanup", 5000).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
