"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { execFileSync, spawnSync } = require("node:child_process");
const { installLinuxShortcut } = require("../../electron/linux-shortcut");
const linux = { skip: process.platform !== "linux" };
function fixture(t, special = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-shortcut-auto-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, special ? 'home é %f "quote" \\ $value `tick` = sign' : "home");
  const desktop = path.join(home, "Bureau local"), dataHome = path.join(home, "local data %U"), launched = path.join(root, "launched.txt");
  const appImage = path.join(home, "Applications/Koinos-AI-Test-0.54.13-test.222.1-arm64.AppImage");
  fs.mkdirSync(desktop, { recursive: true }); fs.mkdirSync(path.dirname(appImage), { recursive: true });
  fs.writeFileSync(appImage, '#!/bin/bash\nprintf "%s\\n%s\\n%s\\n" "$0" "$PWD" "$#" > "$KAI_FIXTURE_LAUNCHED"\n', { mode: 0o755 });
  const options = { platform: "linux", packaged: true, home, desktop, dataHome, appImage, channel: "test", uid: 1000 };
  const install = extra => installLinuxShortcut({ ...options, ...extra });
  return { root, home, desktop, dataHome, appImage, launched, options, install,
    launcher: path.join(dataHome, "koinos-ai-test/launcher/launch.sh"), env: { ...process.env, KAI_FIXTURE_LAUNCHED: launched } };
}

test("packaged AppImage creates channel-specific launchers without launching or changing the shared profile", linux, t => {
  const f = fixture(t), result = f.install();
  assert.equal(result.installed, true); assert.equal(fs.existsSync(f.launched), false);
  assert.equal(path.basename(result.desktop), "Koinos AI Test.desktop");
  assert.equal(path.basename(result.menu), "io.koinosai.appimage.test.desktop");
  assert.match(fs.readFileSync(result.menu, "utf8"), /Name=Koinos AI Test\n/);
  assert.doesNotMatch(fs.readFileSync(f.launcher, "utf8"), /no-sandbox|KAI_CORE_DATA|KAI_CHANNEL|autostart/);
  execFileSync("bash", [f.launcher], { env: f.env });
  assert.equal(fs.readFileSync(f.launched, "utf8"), [f.appImage, path.dirname(f.appImage), "0", ""].join("\n"));
  const first = fs.statSync(result.desktop).mtimeMs; f.install(); assert.equal(fs.statSync(result.desktop).mtimeMs, first);
  fs.chmodSync(f.launcher, 0o600); fs.chmodSync(result.desktop, 0o600);
  f.install(); assert.equal(fs.statSync(f.launcher).mode & 0o777, 0o755); assert.equal(fs.statSync(result.desktop).mode & 0o777, 0o755);
  const stable = f.install({ channel: "stable" });
  assert.equal(path.basename(stable.desktop), "Koinos AI.desktop");
  assert.notEqual(stable.menu, result.menu); assert.equal(fs.existsSync(result.menu), true);
});

test("a versioned AppImage rename refreshes its existing icon and preserves a deliberately deleted desktop icon", linux, t => {
  const f = fixture(t), result = f.install();
  const next = f.appImage.replace("222.1", "223.1"); fs.renameSync(f.appImage, next);
  f.install({ appImage: next }); execFileSync("bash", [f.launcher], { env: f.env });
  assert.equal(fs.readFileSync(f.launched, "utf8"), [next, path.dirname(next), "0", ""].join("\n"));
  fs.unlinkSync(result.desktop); f.install({ appImage: next });
  assert.equal(fs.existsSync(result.desktop), false); assert.equal(fs.existsSync(result.menu), true);
});

test("Linux with desktop icons disabled still receives an application menu launcher", linux, t => {
  const f = fixture(t), result = f.install({ desktop: f.home });
  assert.equal(result.installed, true); assert.equal(result.desktop, null); assert.equal(fs.existsSync(result.menu), true);
  const enabled = f.install(); assert.equal(fs.existsSync(enabled.desktop), true);
});

test("unpackaged apps, other platforms and root launches do not create desktop files", linux, t => {
  const f = fixture(t);
  for (const extra of [{ packaged: false }, { platform: "win32" }, { platform: "darwin" }, { uid: 0 }, { appImage: "" }]) {
    assert.equal(f.install(extra).installed, false);
  }
  assert.equal(fs.existsSync(f.dataHome), false);
});

test("automatic launcher refuses unrelated files, symlinks and malformed runtime paths", linux, t => {
  const f = fixture(t), desktop = path.join(f.desktop, "Koinos AI Test.desktop");
  fs.writeFileSync(desktop, "User desktop entry\n"); assert.throws(() => f.install(), /unrelated desktop shortcut/);
  assert.equal(fs.readFileSync(desktop, "utf8"), "User desktop entry\n"); assert.equal(fs.existsSync(f.dataHome), false);
  fs.unlinkSync(desktop); fs.symlinkSync(f.appImage, desktop); assert.throws(() => f.install(), /unrelated desktop shortcut/);
  fs.unlinkSync(desktop);
  assert.throws(() => f.install({ appImage: f.appImage + "\n" }), /could not be verified/);
  assert.throws(() => f.install({ dataHome: "relative" }), /could not be verified/);
  assert.equal(fs.existsSync(f.dataHome), false);
});

test("a real GLib launcher decodes automatic entries with reserved characters and no injected arguments", linux, async t => {
  if (spawnSync("python3", ["-c", "import ctypes; ctypes.CDLL('libgio-2.0.so.0')"], { stdio: "ignore" }).status !== 0) return t.skip("GLib/GIO and Python are required");
  const f = fixture(t, true), result = f.install();
  const code = `import ctypes,sys
c=ctypes.CDLL('libgio-2.0.so.0')
c.g_desktop_app_info_new_from_filename.argtypes=[ctypes.c_char_p]
c.g_desktop_app_info_new_from_filename.restype=ctypes.c_void_p
c.g_app_info_launch.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.POINTER(ctypes.c_void_p)]
c.g_app_info_launch.restype=ctypes.c_int
app=c.g_desktop_app_info_new_from_filename(sys.argv[1].encode())
assert app, 'Desktop Entry was rejected by GLib'
error=ctypes.c_void_p()
assert c.g_app_info_launch(app,None,None,ctypes.byref(error)), 'GLib could not launch the Desktop Entry'
`;
  execFileSync("python3", ["-c", code, result.menu], { env: f.env });
  for (let i = 0; i < 100 && !fs.existsSync(f.launched); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.readFileSync(f.launched, "utf8"), [f.appImage, path.dirname(f.appImage), "0", ""].join("\n"));
});
