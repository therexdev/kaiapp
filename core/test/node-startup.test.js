"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { loginStartup } = require("../../electron/login-startup");
test("login startup is opt-in, reversible and bound to this installed app", () => {
  let enabled = false; const writes = [];
  const app = { isPackaged: true, getLoginItemSettings: () => ({ openAtLogin: enabled }),
    setLoginItemSettings: options => { writes.push(options); enabled = options.openAtLogin; } };
  const startup = loginStartup(app, { platform: "win32", executable: "C:\\Apps\\Master Koinos AI Node.exe", name: "io.koinosai.desktop.master" });
  assert.deepEqual(startup.status(), { supported: true, enabled: false }); assert.deepEqual(writes, []);
  assert.equal(startup.set(true).enabled, true); assert.equal(startup.set(false).enabled, false);
  for (const write of writes) { assert.equal(write.name, "io.koinosai.desktop.master"); assert.deepEqual(write.args, []); assert.match(write.path, /Master Koinos AI Node.exe$/); }
  assert.throws(() => startup.set("C:\\other.exe"), /on or off/);
});
test("source installs and non-Windows platforms do not register login jobs", () => {
  for (const options of [{ platform: "win32", packaged: false }, { platform: "linux", packaged: true }]) {
    const app = { isPackaged: options.packaged, setLoginItemSettings: () => assert.fail("must not register"), getLoginItemSettings: () => assert.fail("unsupported OS") };
    const startup = loginStartup(app, options); assert.equal(startup.status().supported, false); assert.throws(() => startup.set(true), /installed Windows/);
  }
});
