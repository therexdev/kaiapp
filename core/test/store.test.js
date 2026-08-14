"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { JsonStore, deepMerge } = require("../lib/store");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kai-store-")), "s.json");
}

test("get/set with dotted paths persists atomically", () => {
  const file = tmpFile();
  const s = new JsonStore(file, { a: { b: 1 } });
  assert.equal(s.get("a.b"), 1);
  s.set("a.c.d", "x");
  const reread = new JsonStore(file);
  assert.equal(reread.get("a.c.d"), "x");
  assert.equal(reread.get("a.b"), 1);
  assert.ok(!fs.existsSync(file + ".tmp"), "tmp file cleaned up by rename");
});

test("corrupt file falls back to defaults", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{nope");
  const s = new JsonStore(file, { ok: true });
  assert.equal(s.get("ok"), true);
});

test("deepMerge merges nested objects and overwrites arrays", () => {
  const out = deepMerge({ a: { x: 1, y: 2 }, list: [1] }, { a: { y: 3 }, list: [2, 3] });
  assert.deepEqual(out, { a: { x: 1, y: 3 }, list: [2, 3] });
});
