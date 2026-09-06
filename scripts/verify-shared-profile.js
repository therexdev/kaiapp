"use strict";

// Exercise two separate Windows executable paths/names and real Electron/DPAPI.
// No Core, wallet key, network node or existing desktop profile is opened.
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { setTimeout: delay } = require("timers/promises");

async function main() {
  if (process.platform !== "win32") throw new Error("Run the native shared-profile check on Windows");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-native-profile-"));
  const appData = path.join(root, "app-data");
  fs.mkdirSync(appData);
  const children = [];
  const executables = {};
  try {
    for (const role of ["stable", "test"]) {
      const productName = role === "stable" ? "Koinos AI" : "Koinos AI Test";
      const folder = path.join(root, role);
      fs.cpSync(path.dirname(require("electron")), folder, { recursive: true });
      const executable = path.join(folder, `${productName}.exe`);
      fs.renameSync(path.join(folder, "electron.exe"), executable);
      const appFolder = path.join(folder, "resources", "app");
      fs.mkdirSync(appFolder, { recursive: true });
      fs.writeFileSync(path.join(appFolder, "package.json"), JSON.stringify({
        name: role === "stable" ? "koinos-ai" : "koinos-ai-test",
        productName, version: "1.0.0", main: "main.js",
      }));
      fs.copyFileSync(path.join(__dirname, "fixtures/shared-profile-electron.js"), path.join(appFolder, "main.js"));
      executables[role] = executable;
    }
    async function start(role) {
      const id = children.length;
      const resultFile = path.join(root, `result-${id}.json`);
      const stopFile = path.join(root, `stop-${id}`);
      const env = { ...process.env,
        KAI_PROFILE_CHECK_CONFIG: path.join(__dirname, "../core/lib/release-channel.js"),
        KAI_PROFILE_CHECK_DATA: appData, KAI_PROFILE_CHECK_ROLE: role,
        KAI_PROFILE_CHECK_RESULT: resultFile, KAI_PROFILE_CHECK_STOP: stopFile,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executables[role], [], { env, stdio: ["ignore", "pipe", "pipe"] });
      const record = { child, stopFile, output: "", closed: false };
      children.push(record);
      child.stdout.on("data", data => { record.output = (record.output + data).slice(-6000); });
      child.stderr.on("data", data => { record.output = (record.output + data).slice(-6000); });
      child.on("error", error => { record.error = error; });
      record.done = new Promise(resolve => child.on("close", code => { record.closed = true; record.code = code; resolve(); }));
      const deadline = Date.now() + 30000;
      while (!fs.existsSync(resultFile)) {
        if (record.error) throw record.error;
        if (record.closed || Date.now() > deadline) throw new Error(`${role} did not report: ${record.output}`);
        await delay(50);
      }
      record.result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
      assert.equal(record.result.error, undefined, record.result.error);
      return record;
    }
    async function stop(record) {
      fs.writeFileSync(record.stopFile, "quit");
      const deadline = Date.now() + 10000;
      while (!record.closed && Date.now() < deadline) await delay(30);
      assert.ok(record.closed, "Electron did not quit cleanly");
      assert.equal(record.code, 0, record.output);
    }
    const live = await start("stable");
    assert.equal(live.result.locked, true);
    assert.equal(live.result.name, "Koinos AI");
    assert.equal(live.result.profile, path.join(appData, "Koinos AI"));
    const blockedTest = await start("test");
    assert.equal(blockedTest.result.locked, false, "Test must not open data while Live owns it");
    await stop(blockedTest);
    await stop(live);

    const test = await start("test");
    assert.equal(test.result.locked, true);
    assert.equal(test.result.profile, live.result.profile);
    assert.equal(test.result.name, live.result.name);
    assert.equal(test.result.decrypted, "synthetic-live-wallet-session-secret");
    const blockedLive = await start("stable");
    assert.equal(blockedLive.result.locked, false, "Existing Live must not open data while Test owns it");
    await stop(blockedLive);
    await stop(test);
    console.log("PASS: Live and Test share one profile, exclude each other in both directions, and reuse the live OS-encrypted credential.");
  } finally {
    for (const record of children) if (!record.closed) record.child.kill();
    await Promise.all(children.map(record => record.done));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
