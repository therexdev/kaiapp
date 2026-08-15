"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");
const { DocStore } = require("../lib/docs");

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-custom-"));
  const models = new ModelManager({
    catalogPath: path.join(__dirname, "..", "models", "catalog.json"),
    modelsDir: path.join(dir, "models"),
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: () => {},
  });
  return { dir, models };
}

test("custom import: hash-identified, resolvable, servable in place — and removable without touching the file", async () => {
  const { dir, models } = mk();
  const gguf = path.join(dir, "My Fine-Tune v2.gguf");
  fs.writeFileSync(gguf, "fake weights for hashing");
  const wantSha = crypto.createHash("sha256").update("fake weights for hashing").digest("hex");

  const entry = await models.importCustom({ path: gguf });
  assert.strictEqual(entry.sha256, wantSha, "identity is the real SHA-256 of the file");
  assert.strictEqual(entry.label, "My Fine-Tune v2");
  assert.match(entry.alias, /^custom-my-fine-tune-v2$/);

  const listed = models.aliases().find((a) => a.alias === entry.alias);
  assert.ok(listed && listed.custom && listed.status === "ready");

  const resolved = models.resolveAlias(entry.alias);
  assert.strictEqual(resolved.packageId, `custom:${wantSha}`);
  assert.strictEqual(await models.ensurePackage(resolved.packageId), gguf, "served from where it lives — no copy");

  // Removing forgets the registration, never the user's file.
  models.removeCustom(entry.alias);
  assert.ok(!models.aliases().some((a) => a.alias === entry.alias));
  assert.ok(fs.existsSync(gguf), "the file is the user's — untouched");
});

test("custom import: duplicates refused, non-gguf refused, moved file fails with a clean re-import hint", async () => {
  const { dir, models } = mk();
  const gguf = path.join(dir, "m.gguf");
  fs.writeFileSync(gguf, "weights-a");
  const entry = await models.importCustom({ path: gguf });

  await assert.rejects(() => models.importCustom({ path: gguf }), /Already imported/);
  await assert.rejects(() => models.importCustom({ path: path.join(dir, "state.json") }), /\.gguf/);
  await assert.rejects(() => models.importCustom({ path: path.join(dir, "nope.gguf") }), /No file at/);

  fs.renameSync(gguf, gguf + ".moved");
  assert.strictEqual(models.aliases().find((a) => a.alias === entry.alias).status, "missing");
  await assert.rejects(() => models.ensurePackage(`custom:${entry.sha256}`), /re-import/);
});

test("§32 reaches imported models: quarantine by sha kills a custom model too", async () => {
  const { dir, models } = mk();
  const gguf = path.join(dir, "sus.gguf");
  fs.writeFileSync(gguf, "compromised weights");
  const entry = await models.importCustom({ path: gguf });

  const hit = models.quarantineBySha(entry.sha256, "poisoned build");
  assert.deepStrictEqual(hit, [`custom:${entry.sha256}`]);
  assert.strictEqual(models.aliases().find((a) => a.alias === entry.alias).status, "quarantined");
  assert.throws(() => models.resolveAlias(entry.alias), /quarantined/);
  await assert.rejects(() => models.ensurePackage(`custom:${entry.sha256}`), /quarantined/);
});

test("doc store: save/list/get/remove round-trip with auto-title from the first line", () => {
  const store = new DocStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kai-docs-")), "docs"));
  const { id, title } = store.save({ content: "# Launch plan\n\nShip the beta, then listen." });
  assert.strictEqual(title, "Launch plan", "first line becomes the title, heading marks stripped");

  const listed = store.list();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].words, 8, "raw whitespace-token count (heading marks included)");

  store.save({ id, title: "Renamed", content: "New words." });
  assert.strictEqual(store.get(id).title, "Renamed");
  assert.strictEqual(store.get(id).content, "New words.");

  store.remove(id);
  assert.strictEqual(store.list().length, 0);
});
