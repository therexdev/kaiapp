"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { execFileSync, spawnSync } = require("node:child_process");
const script = path.resolve(__dirname, "../../scripts/install-linux-shortcut.sh");
const linux = { skip: process.platform !== "linux" };
function fixture(t, special = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-shortcut-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, special ? 'home é spaces %f "quote" \\ $value `tick` = sign' : "home");
  const desktop = path.join(home, "Bureau local"), bin = path.join(root, "bin"), data = path.join(home, "local data %U");
  const app = path.join(home, "Applications/KoinosAI/Koinos-AI-Alpha.AppImage"), launched = path.join(root, "launched.txt");
  for (const dir of [home, desktop, bin, path.dirname(app)]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, "xdg-user-dir"), '#!/bin/bash\nprintf "%s\\n" "$KAI_FIXTURE_DESKTOP"\n', { mode: 0o755 });
  fs.writeFileSync(app, '#!/bin/bash\nprintf "%s\\n%s\\n%s\\n" "$0" "$PWD" "$#" > "$KAI_FIXTURE_LAUNCHED"\n', { mode: 0o644 });
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: data, KAI_FIXTURE_DESKTOP: desktop, KAI_FIXTURE_LAUNCHED: launched, PATH: bin + path.delimiter + process.env.PATH };
  delete env.SUDO_USER;
  const run = (...args) => execFileSync("bash", [script, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { root, home, desktop, app, launched, env, run, data,
    launcher: path.join(data, "koinos-ai/launcher/launch.sh"), menu: path.join(data, "applications/io.koinosai.appimage.desktop"), shortcut: path.join(desktop, "Koinos AI.desktop") };
}

test("Linux shortcut uses the existing Alpha file and actual desktop directory without starting the app", linux, t => {
  const f = fixture(t); assert.match(f.run(), /Created Koinos AI/);
  assert.equal(fs.existsSync(f.launched), false);
  assert.ok(fs.statSync(f.shortcut).mode & 0o100); assert.ok(fs.statSync(f.app).mode & 0o100);
  assert.equal(fs.readFileSync(f.menu, "utf8"), fs.readFileSync(f.shortcut, "utf8"));
  assert.match(fs.readFileSync(f.menu, "utf8"), /Terminal=false/);
  assert.doesNotMatch(fs.readFileSync(f.launcher, "utf8"), /no-sandbox|KAI_CORE_DATA|KAI_CHANNEL|autostart/);
  execFileSync("bash", [f.launcher], { env: f.env });
  assert.equal(fs.readFileSync(f.launched, "utf8"), [f.app, path.dirname(f.app), "0", ""].join("\n"));
  const first = fs.readFileSync(f.menu, "utf8"); f.run(); assert.equal(fs.readFileSync(f.menu, "utf8"), first);
});

test("Linux launcher keeps the versionless target after an AppImage replacement and accepts an explicit path", linux, t => {
  const f = fixture(t); const custom = path.join(f.home, 'other folder/Koinos "AI" 100% $cash `tick`.AppImage');
  fs.mkdirSync(path.dirname(custom)); fs.renameSync(f.app, custom); f.run(custom);
  fs.writeFileSync(custom, '#!/bin/bash\nprintf updated > "$KAI_FIXTURE_LAUNCHED"\n', { mode: 0o755 }); fs.chmodSync(custom, 0o755);
  execFileSync("bash", [f.launcher], { env: f.env }); assert.equal(fs.readFileSync(f.launched, "utf8"), "updated");
});

test("Linux shortcut rejects missing, versioned, linked and control-character paths before writing shortcuts", linux, t => {
  const f = fixture(t); fs.unlinkSync(f.app);
  assert.throws(() => f.run(), /AppImage not found/);
  const versioned = path.join(f.home, "Koinos-AI-1.2.3.AppImage"); fs.writeFileSync(versioned, "fixture");
  assert.throws(() => f.run(versioned), /versionless/);
  const linked = path.join(f.home, "linked.AppImage"); fs.symlinkSync(versioned, linked);
  assert.throws(() => f.run(linked), /AppImage not found/);
  assert.throws(() => f.run(path.join(f.home, "line\nbreak.AppImage")), /control characters/);
  assert.equal(fs.existsSync(f.data), false);
});

test("Linux shortcut preserves an unrelated desktop file and refuses a disabled desktop", linux, t => {
  const f = fixture(t); fs.writeFileSync(f.shortcut, "User custom launcher\n");
  assert.throws(() => f.run(), /unrelated file/);
  assert.equal(fs.readFileSync(f.shortcut, "utf8"), "User custom launcher\n"); assert.equal(fs.existsSync(f.launcher), false);
  fs.unlinkSync(f.shortcut); f.env.KAI_FIXTURE_DESKTOP = f.home;
  assert.throws(() => f.run(), /Desktop icons are disabled/); assert.equal(fs.existsSync(f.launcher), false);
});

test("a real GLib desktop launcher decodes reserved path characters and passes no extra arguments", linux, async t => {
  const available = spawnSync("python3", ["-c", "import ctypes; ctypes.CDLL('libgio-2.0.so.0')"], { stdio: "ignore" }).status === 0;
  if (!available) return t.skip("GLib/GIO and Python are required for this desktop parser integration test");
  const f = fixture(t, true); f.run();
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
  execFileSync("python3", ["-c", code, f.menu], { env: f.env });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(f.launched); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.readFileSync(f.launched, "utf8"), [f.app, path.dirname(f.app), "0", ""].join("\n"));
});
