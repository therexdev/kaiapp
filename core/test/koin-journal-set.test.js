"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { DatabaseSync } = require("node:sqlite");
const { JournalSet } = require("../lib/koin-network/journal-set");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");
function setup(t) {
  const f = fixture(t), backups = fs.mkdtempSync(path.join(os.tmpdir(), "koin-backup-test-"));
  const guard = new JournalSet(f.dir, { maintenance: true });
  t.after(() => { guard.close(); fs.rmSync(backups, { recursive: true, force: true }); });
  return { ...f, guard, backup: name => path.join(backups, name) };
}
test("coherent backup preserves unresolved envelopes and restores only with all writers closed", async t => {
  const f = setup(t); await f.runner().start(f.id, f.request); f.journal.hold(f.id);
  const target = f.backup("current"), manifest = f.guard.snapshot(target);
  assert.equal(manifest.files.length, 2); assert.equal(f.guard.inspect(target).restorable, true);
  assert.throws(() => f.guard.restore(target), /Close every journal writer/);
  f.journal.close(); assert.equal(f.guard.restore(target).restored, true);
  const reopened = f.open(); assert.equal(reopened.status(f.id).held, true);
  assert.equal((await f.runner(reopened).tick(f.id)).reason, "funding_user_stopped");
  assert.equal(f.state.signed, 1); assert.equal(f.state.submissions.length, 1);
});
test("an older valid backup cannot rewind activity or restore a new signing opportunity", async t => {
  const f = setup(t), old = f.backup("old"); f.guard.snapshot(old);
  await f.runner().start(f.id, f.request); assert.equal(f.guard.inspect(old).restorable, false);
  f.journal.close(); assert.throws(() => f.guard.restore(old), /cannot rewind/);
  const j = f.open(); assert.equal(j.nonceCoordinator.status(f.id).state, "signed");
});
test("missing journals can be recovered from the witnessed latest backup without resetting the anchor", async t => {
  const f = setup(t); await f.journal.begin(f.id, f.request);
  const backup = f.backup("current"); f.guard.snapshot(backup); f.journal.close();
  fs.rmSync(path.join(f.dir, "funding-recovery.sqlite"));
  assert.throws(() => f.open(), /Tracked funding journal missing/);
  assert.equal(f.guard.restore(backup).restored, true);
  assert.equal((await f.runner(f.open()).start(f.id, f.request)).reason, "recover_signing_envelope");
  assert.equal(f.state.signed, 0);
});
test("raw replacement of either older journal is detected even when the other has the newest generation", async t => {
  const f = setup(t), old = f.backup("old"); f.guard.snapshot(old);
  await f.runner().start(f.id, f.request); f.journal.close();
  fs.copyFileSync(path.join(old, "funding-recovery.sqlite"), path.join(f.dir, "funding-recovery.sqlite"));
  assert.throws(() => f.open(), /generation mismatch/);
});
test("changed backup bytes or manifest and an absent recovery anchor fail closed", async t => {
  const f = setup(t), p = f.backup("backup"); f.guard.snapshot(p);
  const file = path.join(p, "wallet-nonces.sqlite"), bytes = fs.readFileSync(file); bytes[200] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => f.guard.inspect(p), /checksum/);
  const next = f.backup("manifest"); f.guard.snapshot(next);
  const m = path.join(next, "manifest.json"); fs.appendFileSync(m, " ");
  assert.throws(() => f.guard.inspect(next), /altered/);
  const missing = f.backup("missing-anchor"); fs.mkdirSync(missing);
  fs.copyFileSync(path.join(p, "funding-recovery.sqlite"), path.join(missing, "funding-recovery.sqlite"));
  assert.throws(() => new JournalSet(missing), /anchor missing/);
});
test("an interrupted dual commit is blocked by the independent generation witness", async t => {
  const f = setup(t); f.journal.close();
  const db = new DatabaseSync(path.join(f.dir, "wallet-nonces.sqlite"));
  db.exec("UPDATE recovery_generation SET generation=generation+1"); db.close();
  assert.throws(() => f.open(), /generation mismatch/);
});
