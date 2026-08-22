"use strict";

/*
 * Removing an installed model.
 *
 * The whole risk in this feature is one distinction. "Installed" means two
 * different things here:
 *
 *   - a CATALOG model, downloaded by us into our own models directory.
 *     Removing it should really delete the bytes; that is the point.
 *   - an IMPORTED model, which is the user's own .gguf sitting wherever they
 *     keep it. We only hold a reference. Removing it must forget the
 *     reference and leave the file completely alone.
 *
 * Get those two the wrong way round and "uninstall" deletes someone's own
 * fine-tune out of their Downloads folder. Most of what follows exists to
 * hold that line.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");

const REAL_CATALOG = path.join(__dirname, "..", "models", "catalog.json");

function mk({ catalogPath = REAL_CATALOG } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-uninstall-"));
  const modelsDir = path.join(dir, "models");
  fs.mkdirSync(modelsDir, { recursive: true });
  const events = [];
  const models = new ModelManager({
    catalogPath,
    modelsDir,
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: (e) => events.push(e),
  });
  return { dir, modelsDir, models, events };
}

/** Pretend a package finished downloading, with `bytes` of weights. */
function install(models, packageId, bytes = 4096) {
  const f = models.packagePath(packageId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "w".repeat(bytes));
  return f;
}

function firstPlainPackage(models) {
  return Object.keys(models.catalog.packages).find((id) => !models.catalog.packages[id].mmproj);
}

// ------------------------------------------------- downloaded models really go

test("removing a downloaded model deletes the weights and reports what it freed", () => {
  const { models } = mk();
  const id = firstPlainPackage(models);
  const file = install(models, id, 10000);

  assert.equal(models.packageStatus(id).status, "ready");
  const plan = models.removalPlan(id);
  assert.equal(plan.kind, "downloaded");
  assert.equal(plan.freesBytes, 10000, "the plan quotes what is actually on disk");
  assert.equal(plan.redownloadable, true);

  const r = models.removePackage(id);
  assert.equal(r.removed, true);
  assert.equal(r.freedBytes, 10000);
  assert.equal(fs.existsSync(file), false, "the file is gone");
  assert.equal(models.packageStatus(id).status, "absent", "and the catalog agrees it is gone");
});

test("a cancelled download's .part file is removed too", () => {
  /*
   * These were unreachable before: a cancelled download leaves a .part taking
   * gigabytes, the UI offers only "Download" on that row, and nothing in the
   * app frees it. Recovering that space is half the reason to have this
   * feature at all.
   */
  const { models } = mk();
  const id = firstPlainPackage(models);
  const part = models.packagePath(id) + ".part";
  fs.writeFileSync(part, "p".repeat(2500));

  assert.equal(models.packageStatus(id).status, "partial");
  const plan = models.removalPlan(id);
  assert.equal(plan.freesBytes, 2500, "a half-finished download frees what it actually holds, not the full size");

  models.removePackage(id);
  assert.equal(fs.existsSync(part), false);
  assert.equal(models.packageStatus(id).status, "absent");
});

test("removing a model that was never downloaded is harmless, not an error", () => {
  const { models } = mk();
  const id = firstPlainPackage(models);
  const plan = models.removalPlan(id);
  assert.equal(plan.freesBytes, 0);
  assert.deepEqual(plan.deletesFiles, []);
  const r = models.removePackage(id);
  assert.equal(r.removed, true, "nothing to do is still success — the end state is what was asked for");
});

test("storage usage drops by what was removed", () => {
  const { models } = mk();
  const ids = Object.keys(models.catalog.packages).filter((i) => !models.catalog.packages[i].mmproj).slice(0, 2);
  install(models, ids[0], 6000);
  install(models, ids[1], 4000);
  assert.equal(models.storageUsage().bytes, 10000);
  models.removePackage(ids[0]);
  assert.equal(models.storageUsage().bytes, 4000, "the number the Models screen shows is now honest");
});

// ------------------------------------------- imported models are NOT ours to delete

test("removing an imported model forgets it WITHOUT deleting the user's file", async () => {
  const { dir, models } = mk();
  const mine = path.join(dir, "My Fine-Tune.gguf");
  fs.writeFileSync(mine, "weights I made myself");
  const sha = crypto.createHash("sha256").update("weights I made myself").digest("hex");

  const entry = await models.importCustom({ path: mine });
  const pkgId = `custom:${sha}`;

  const plan = models.removalPlan(pkgId);
  assert.equal(plan.kind, "imported");
  assert.deepEqual(plan.deletesFiles, [], "the plan promises to delete nothing");
  assert.equal(plan.keepsFile, mine, "and names the file it is leaving alone");
  assert.equal(plan.freesBytes, 0, "so it must not claim to free space it will not free");

  const r = models.removePackage(pkgId);
  assert.equal(r.removed, true);
  assert.equal(r.kind, "imported");

  assert.equal(fs.existsSync(mine), true, "THE USER'S FILE IS STILL THERE");
  assert.equal(fs.readFileSync(mine, "utf8"), "weights I made myself", "and is untouched");
  assert.equal(
    models.aliases().some((a) => a.alias === entry.alias),
    false,
    "but it has left the list",
  );
});

// ----------------------------------------------------- the loaded model is safe

test("the model currently loaded cannot be removed out from under the runtime", () => {
  const { models } = mk();
  const id = firstPlainPackage(models);
  const file = install(models, id);

  assert.throws(
    () => models.removePackage(id, { isInUse: true }),
    /loaded right now/i,
    "and the message says what to do about it",
  );
  assert.equal(fs.existsSync(file), true, "nothing was deleted on the way to refusing");
});

// ------------------------------------------- the vision projector is shared state

test("the vision projector goes with the last model that needs it", () => {
  const { models, modelsDir } = mk();
  const visionId = Object.keys(models.catalog.packages).find((i) => models.catalog.packages[i].mmproj);
  assert.ok(visionId, "the catalog still ships a vision package");

  install(models, visionId, 5000);
  const mmproj = path.join(modelsDir, models.catalog.packages[visionId].mmproj.filename);
  fs.writeFileSync(mmproj, "m".repeat(1500));

  const plan = models.removalPlan(visionId);
  assert.ok(plan.deletesFiles.includes(mmproj), "the projector is removed with the model that needs it");
  assert.equal(plan.freesBytes, 6500, "and counts toward what is freed");

  models.removePackage(visionId);
  assert.equal(fs.existsSync(mmproj), false);
});

test("a projector another installed model still needs is KEPT", () => {
  /*
   * Two packages can pin the same projector. Removing one must not break
   * vision for the other — a bug that would only show up as "images stopped
   * working" long after the uninstall that caused it.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mmproj-"));
  const catalogPath = path.join(dir, "catalog.json");
  const shared = "shared-mmproj-f16.gguf";
  fs.writeFileSync(catalogPath, JSON.stringify({
    packages: {
      "vision-a@1": { filename: "a.gguf", url: "https://x/a", sha256: "a".repeat(64), sizeBytes: 10, vision: true,
        mmproj: { filename: shared, url: "https://x/m", sha256: "c".repeat(64), sizeBytes: 5 } },
      "vision-b@1": { filename: "b.gguf", url: "https://x/b", sha256: "b".repeat(64), sizeBytes: 10, vision: true,
        mmproj: { filename: shared, url: "https://x/m", sha256: "c".repeat(64), sizeBytes: 5 } },
    },
    aliases: { "va": { package: "vision-a@1", label: "A" }, "vb": { package: "vision-b@1", label: "B" } },
  }));
  const modelsDir = path.join(dir, "models");
  fs.mkdirSync(modelsDir, { recursive: true });
  const models = new ModelManager({
    catalogPath, modelsDir,
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: () => {},
  });

  fs.writeFileSync(path.join(modelsDir, "a.gguf"), "aaaa");
  fs.writeFileSync(path.join(modelsDir, "b.gguf"), "bbbb");
  const mm = path.join(modelsDir, shared);
  fs.writeFileSync(mm, "mmmm");

  const plan = models.removalPlan("vision-a@1");
  assert.ok(!plan.deletesFiles.includes(mm), "B still needs it, so it stays");
  models.removePackage("vision-a@1");
  assert.equal(fs.existsSync(mm), true, "vision still works for B");
  assert.equal(fs.existsSync(path.join(modelsDir, "b.gguf")), true);

  // Now B goes too: the projector has no one left to serve.
  const plan2 = models.removalPlan("vision-b@1");
  assert.ok(plan2.deletesFiles.includes(mm), "the last one out takes it");
  models.removePackage("vision-b@1");
  assert.equal(fs.existsSync(mm), false, "no orphaned projector left behind");
});

// ------------------------------------------------------------------- reporting

test("removal is announced, so anything watching can refresh", () => {
  const { models, events } = mk();
  const id = firstPlainPackage(models);
  install(models, id, 3000);
  models.removePackage(id);
  const ev = events.find((e) => e.type === "model:removed");
  assert.ok(ev, "an event is emitted");
  assert.equal(ev.freedBytes, 3000);
  assert.equal(ev.kind, "downloaded");
});

test("an unknown package is rejected rather than silently doing nothing", () => {
  const { models } = mk();
  assert.throws(() => models.removalPlan("not-a-real-package@9"), /Unknown package/);
  assert.throws(() => models.removePackage("custom:deadbeef"), /Unknown package/);
});
