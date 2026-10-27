"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { initializeDesktopProfile } = require("../../electron/desktop-first-run"), { JsonStore } = require("../lib/store");
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-first-desktop-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return path.join(root, "core"); }

test("a fresh desktop profile enables free network access once and preserves subsequent Local-Only", t => {
  const dir = fixture(t); assert.equal(initializeDesktopProfile(dir), true);
  const settings = new JsonStore(path.join(dir, "settings.json")); assert.equal(settings.get("network.privacyMode"), "local-first");
  if (process.platform !== "win32") assert.equal(fs.statSync(settings.filePath).mode & 0o777, 0o600);
  settings.set("network.privacyMode", "local-only"); const before = fs.readFileSync(settings.filePath);
  assert.equal(initializeDesktopProfile(dir), false); assert.deepEqual(fs.readFileSync(settings.filePath), before);
});
test("existing empty, legacy, unreadable and explicit privacy profiles never receive a new online default", async t => {
  for (const value of [null, "{}", "corrupt settings preserved", JSON.stringify({ network: { privacyMode: "local-only" } }), JSON.stringify({ network: { privacyMode: "network" } })]) {
    await t.test(String(value), t => {
      const dir = fixture(t); fs.mkdirSync(dir); const file = path.join(dir, "settings.json");
      if (value !== null) fs.writeFileSync(file, value);
      assert.equal(initializeDesktopProfile(dir), false);
      if (value !== null) assert.equal(fs.readFileSync(file, "utf8"), value); else assert.equal(fs.existsSync(file), false);
    });
  }
});
test("core and headless startup retains Local-Only by default without desktop initialization", async t => {
  const dir = fixture(t), core = await require("../server").createCore({ dataDir: dir, port: 0, onEvent() {} });
  t.after(() => core.stop()); assert.equal(core.gateway.network.status().privacyMode, "local-only");
});
