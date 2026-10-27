"use strict";

// Run under xvfb-run on Linux CI. The Ozone headless backend also supports
// this no-window fixture when a display server is unavailable locally.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process"), { setTimeout: delay } = require("node:timers/promises");
const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";

async function main() {
  if (process.platform !== "linux") throw Error("Run the native Linux relaunch check on Linux");
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--app-dir")) throw Error("Usage: node scripts/verify-linux-relaunch.js [--app-dir dist/linux-arm64-unpacked]");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-linux-relaunch-")), children = [], replacements = [];
  const packaged = args.length > 0, digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const archive = packaged ? path.join(path.resolve(args[1]), "resources/app.asar") : null, archiveHash = archive && digest(archive);
  let electron = require("electron"), fixture = path.join(__dirname, "fixtures/linux-relaunch-electron.js"), sourceRoot = path.resolve(__dirname, "..");
  if (packaged) {
    const copy = path.join(root, "candidate-copy"); fs.cpSync(path.resolve(args[1]), copy, { recursive: true });
    sourceRoot = path.join(copy, "resources/tested-code.asar"); fs.renameSync(path.join(copy, "resources/app.asar"), sourceRoot);
    const unpacked = path.join(copy, "resources/app.asar.unpacked"); if (fs.existsSync(unpacked)) fs.renameSync(unpacked, sourceRoot + ".unpacked");
    electron = path.join(copy, "koinos-ai-test");
    const application = path.join(copy, "resources/app"); fs.mkdirSync(application, { recursive: true });
    fs.writeFileSync(path.join(application, "package.json"), JSON.stringify({ name: "kai-linux-update-fixture", version: "1.0.0", main: "main.js" }));
    fs.copyFileSync(fixture, path.join(application, "main.js")); fixture = null;
  }
  const executableArgs = () => [...flags, ...(fixture ? [fixture] : [])];
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
  function scenario(name, integrationFailure = false) {
    const folder = path.join(root, name); fs.mkdirSync(folder); fs.mkdirSync(path.join(folder, "app-data"));
    const config = { root: folder, releaseChannel: path.join(sourceRoot, "core/lib/release-channel.js"),
      updateRestart: path.join(sourceRoot, "electron/update-restart.js"), lifecycle: path.join(sourceRoot, "electron/desktop-lifecycle.js"),
      updaterModule: path.join(sourceRoot, "electron/appimage-updater.js"), integrationFailure,
      originalExecutable: path.join(folder, "Koinos AI Alpha 1.0.0.AppImage"), replacementExecutable: path.join(folder, "Koinos AI Alpha 1.0.1.AppImage"),
      downloadedExecutable: path.join(folder, "download cache", "Koinos AI Alpha 1.0.1.AppImage") };
    const file = path.join(folder, "config.json");
    const launcher = role => "#!/bin/sh\ntest -f " + shellQuote(file) + " || exit 0\n" +
      "if [ \"$APPIMAGE_EXIT_AFTER_INSTALL\" = true ]; then\n  printf '%s\\n' integration >> " + shellQuote(path.join(folder, "integration.log")) +
      "\n  printf '%s\\n' 'native fixture integration stderr' >&2\n  exit " + (integrationFailure ? 7 : 0) + "\nfi\n" +
      "export KAI_LINUX_RELAUNCH_LAUNCHER=" + shellQuote(role) + "\nexec " + [electron, ...executableArgs()].map(shellQuote).join(" ") + "\n";
    fs.writeFileSync(config.originalExecutable, launcher("original"), { mode: 0o700 });
    fs.mkdirSync(path.dirname(config.downloadedExecutable));
    fs.writeFileSync(config.downloadedExecutable, launcher("replacement"), { mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(config));
    return { ...config, file, result: name => path.join(folder, name + ".json") };
  }
  function launch(config, role, probe) {
    const env = { ...process.env, KAI_LINUX_RELAUNCH_CONFIG: config.file, KAI_LINUX_RELAUNCH_ROLE: role,
      ...(probe ? { KAI_LINUX_RELAUNCH_PROBE: probe } : {}) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, executableArgs(), { env, stdio: ["ignore", "pipe", "pipe"] });
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
    assert.equal(first.locked, true); assert.equal(first.arch, process.arch, "initial Electron matches the native runner architecture");
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
    assert.equal(restarted.parentStderrWrites, 0, "successful integration does not depend on the parent stderr stream");
    assert.equal(fs.readFileSync(path.join(update.root, "integration.log"), "utf8"), "integration\n");
    assert.equal(fs.existsSync(update.downloadedExecutable), false); assert.equal(fs.existsSync(update.originalExecutable), false);
    assert.equal(fs.statSync(update.replacementExecutable).isFile(), true);
    await wait(() => original.exited, "original process exit"); assert.equal(original.code, 0, original.output);
    const next = await result(update, "replacement"); replacements.push({ config: update, role: "replacement", pid: next.pid });
    assert.equal(next.locked, true); assert.equal(next.profile, first.profile); assert.notEqual(next.pid, first.pid);
    assert.equal(next.arch, process.arch, "relaunched Electron matches the native runner architecture");
    assert.equal(next.launcher, "replacement", "the renamed executable path, including spaces, is used for relaunch");
    const events = fs.readFileSync(path.join(update.root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    const cleanup = events.findIndex(event => event.name === "cleanup-finished"), replacement = events.findIndex(event => event.role === "replacement" && event.name === "lock-result");
    assert.ok(cleanup >= 0 && replacement > cleanup, "the replacement acquires the profile only after cleanup");
    assert.equal(events.filter(event => event.role === "replacement" && event.name === "lock-result").length, 1);
    fs.writeFileSync(path.join(update.root, "stop-replacement"), "stop");
    await wait(() => !exists(next.pid), "replacement process exit");

    const installFailure = scenario("integration failure", true), installChild = launch(installFailure, "install-failure");
    assert.equal((await result(installFailure, "install-failure", installChild)).locked, true);
    fs.writeFileSync(path.join(installFailure.root, "restart"), "restart");
    const rejected = await result(installFailure, "restart-error", installChild);
    assert.equal(rejected.expected, true); assert.equal(rejected.installs, 1); assert.equal(rejected.parentStderrWrites, 0);
    assert.equal(rejected.autoInstallOnAppQuit, false); assert.equal(installChild.exited, false, "a failed helper leaves the original GUI alive");
    await blockedProbe(installFailure, "failed-install-contender");
    assert.equal(fs.readFileSync(path.join(installFailure.root, "integration.log"), "utf8"), "integration\n", "duplicate restart never repeats the failed helper");
    fs.writeFileSync(path.join(installFailure.root, "stop-install-failure"), "stop");
    await wait(() => installChild.exited, "controlled failed install exit"); assert.equal(installChild.code, 0, installChild.output);
    assert.equal(fs.readFileSync(path.join(installFailure.root, "integration.log"), "utf8"), "integration\n", "quit never repeats the failed installation");

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
    if (packaged) assert.equal(digest(archive), archiveHash, "original packaged source remains unchanged");
    const summary = { platform: process.platform, arch: process.arch, packaged, archiveSha256: archiveHash,
      realAppImageUpdater: true, helper: "controlled-shell-wrapper", nativeElectron: true, brokenParentStderr: "Writable EFAULT callback",
      failedIntegrationRejected: true, noUncaughtStderrError: true, oneInstallAttempt: true, relaunchAfterCleanup: true,
      sharedProfileExclusion: true, productionProfileOpened: false };
    if (process.env.KAI_NATIVE_QA_DIR) { fs.mkdirSync(process.env.KAI_NATIVE_QA_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.KAI_NATIVE_QA_DIR, "linux-relaunch-" + process.arch + ".json"), JSON.stringify(summary, null, 2) + "\n"); }
    console.log("PASS: native Linux " + process.arch + " real updater handles integration stderr failure without an uncaught error, installs once, waits for exit, preserves the shared singleton and handles renamed paths with spaces. " + (packaged ? "Packaged source verified." : "Source checkout verified."));
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
