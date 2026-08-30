"use strict";

/*
 * The project jail must confine against the real filesystem, not the string.
 *
 * These fail on the old lexical check: path.resolve() + startsWith() calls a
 * symlink inside the project "inside the project", and every file tool then
 * reads or writes through it. Koinos Code clones repositories, so the symlink
 * is something an attacker can simply commit.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { confine } = require("../lib/jail");

/** Symlinks need elevation or developer mode on Windows — skip there if so. */
function canSymlink(dir) {
  try {
    const t = path.join(dir, ".symlink-probe");
    fs.symlinkSync(dir, t, "dir");
    fs.unlinkSync(t);
    return true;
  } catch {
    return false;
  }
}

function scratch() {
  // realpath: macOS hands out /var/... which is itself a link to /private/var.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kai-jail-")));
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "id_rsa"), "PRIVATE KEY");
  fs.writeFileSync(path.join(root, "README.md"), "hello");
  return { base, root, outside };
}

test("ordinary paths inside the project still resolve", () => {
  const { root } = scratch();
  assert.strictEqual(confine(root, "README.md"), path.join(root, "README.md"));
  assert.strictEqual(confine(root, "."), root);
  // A file that does not exist yet must still be placeable — writes depend on it.
  assert.strictEqual(confine(root, "src/new/file.txt"), path.join(root, "src", "new", "file.txt"));
});

test("../ traversal is refused", () => {
  const { root, outside } = scratch();
  assert.strictEqual(confine(root, "../outside/id_rsa"), null);
  assert.strictEqual(confine(root, path.join(outside, "id_rsa")), null);
  assert.strictEqual(confine(root, "/etc/passwd"), null);
});

test("a symlink pointing out of the project is out of the project", (t) => {
  const { root, outside } = scratch();
  if (!canSymlink(root)) return t.skip("symlinks unavailable on this host");

  fs.symlinkSync(outside, path.join(root, "escape"), "dir");
  fs.symlinkSync(path.join(outside, "id_rsa"), path.join(root, "key"), "file");

  // Reading THROUGH a symlinked directory — the classic checked-in escape.
  assert.strictEqual(confine(root, "escape/id_rsa"), null, "symlinked dir escaped the jail");
  // A symlinked file itself.
  assert.strictEqual(confine(root, "key"), null, "symlinked file escaped the jail");
  // And writing a NEW file through the symlinked directory.
  assert.strictEqual(confine(root, "escape/planted.txt"), null, "write escaped the jail");
});

test("a symlink that stays inside the project is allowed, and canonicalised", (t) => {
  const { root } = scratch();
  if (!canSymlink(root)) return t.skip("symlinks unavailable on this host");
  fs.mkdirSync(path.join(root, "real"));
  fs.writeFileSync(path.join(root, "real", "note.txt"), "ok");
  fs.symlinkSync(path.join(root, "real"), path.join(root, "alias"), "dir");
  // Allowed — and it hands back the canonical path, so the caller opens the
  // same bytes the check approved.
  assert.strictEqual(confine(root, "alias/note.txt"), path.join(root, "real", "note.txt"));
});

test("a symlinked project root is its own inside", (t) => {
  const { base, root } = scratch();
  if (!canSymlink(base)) return t.skip("symlinks unavailable on this host");
  const link = path.join(base, "project-link");
  fs.symlinkSync(root, link, "dir");
  // Adding the project by its symlinked path must not make everything escape.
  assert.strictEqual(confine(link, "README.md"), path.join(root, "README.md"));
  assert.strictEqual(confine(link, "../outside/id_rsa"), null);
});

test("a missing root denies rather than guessing", () => {
  const { base } = scratch();
  assert.strictEqual(confine(path.join(base, "nope"), "anything"), null);
});

test("the agent workspace tool jail refuses the same escape", async (t) => {
  const { base } = scratch();
  const dataDir = path.join(base, "data");
  const workspace = path.join(dataDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  if (!canSymlink(workspace)) return t.skip("symlinks unavailable on this host");
  fs.symlinkSync(path.join(base, "outside"), path.join(workspace, "out"), "dir");

  // safePath is not exported; drive it the way the agent does.
  const { ToolRegistry } = require("../lib/tools");
  const { registerBuiltinTools } = require("../lib/builtin-tools");
  const registry = new ToolRegistry({ privacyMode: () => "local-only" });
  registerBuiltinTools(registry, { dataDir });
  const names = registry.list().map((x) => x.name);
  const writer = names.find((n) => /write.*file|save/i.test(n));
  assert.ok(writer, `no file-writing tool registered; saw ${names.join(", ")}`);

  await assert.rejects(
    () => registry.call(writer, { path: "out/id_rsa", name: "out/id_rsa", content: "x" }, { confirmed: true }),
    /escapes the agent workspace/,
    "the workspace tool followed a symlink out of the workspace",
  );
  // And the file on the other side of the link is untouched.
  assert.strictEqual(fs.readFileSync(path.join(base, "outside", "id_rsa"), "utf8"), "PRIVATE KEY");
});
