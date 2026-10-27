"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { DatabaseSync } = require("node:sqlite"), { sqlitePath, filesystemPath } = require("../lib/sqlite-path");
const { JournalSet } = require("../lib/koin-network/journal-set"), { FundingRecovery } = require("../../electron/koin-funding-recovery");
const { fixture } = require("./helpers/koin-funding-recovery-fixture");

function longDirectory(root, label) {
  let directory = path.join(root, label, "Profile with spaces and 50% #");
  while (directory.length < 320) directory = path.join(directory, "nested-profile-" + "x".repeat(24));
  fs.mkdirSync(directory, { recursive: true }); return directory;
}
test("long payment journal paths retain exact signed nonce recovery, backup generations and original filenames", async t => {
  const f = fixture(t), directory = longDirectory(f.dir, "payments"), backupRoot = longDirectory(f.dir, "backups");
  const options = { mode: "isolated-rehearsal", client: f.client, clock: () => f.state.now, maxRcPerDay: "20000000" };
  let journal, guard;
  try {
    assert.ok((directory + ".recovery-anchor.sqlite").length > 300);
    journal = new FundingRecovery(directory, options);
    guard = new JournalSet(directory, { maintenance: true });
    const older = path.join(backupRoot, "older"), current = path.join(backupRoot, "current");
    guard.snapshot(older);
    await f.runner(journal).start(f.id, f.request);
    const signed = structuredClone(f.state.submissions[0]);
    assert.equal(f.state.signed, 1); assert.ok(signed.signatures.length);
    const snapshot = guard.snapshot(current);
    assert.equal(guard.inspect(current).restorable, true);
    journal.close(); journal = null;
    assert.throws(() => guard.restore(older), /cannot rewind/);
    assert.equal(guard.restore(path.toNamespacedPath(current)).restored, true);
    guard.close(); guard = null;
    journal = new FundingRecovery(path.toNamespacedPath(directory), options);
    assert.equal(journal.nonceCoordinator.status(f.id).txId, signed.id);
    f.state.now += 1001; await f.runner(journal).tick(f.id);
    assert.equal(f.state.signed, 1, "restart never signs a replacement transaction");
    assert.deepEqual(f.state.submissions[1], signed);
    journal.close(); journal = null;
    const anchor = new DatabaseSync(sqlitePath(directory + ".recovery-anchor.sqlite"), { readOnly: true });
    try {
      const row = anchor.prepare("SELECT * FROM anchor WHERE id=1").get();
      assert.equal(row.directory, fs.realpathSync(directory)); assert.equal(row.pair_id, snapshot.pairId);
      assert.equal(fs.realpathSync(filesystemPath(anchor.prepare("PRAGMA database_list").get().file)), fs.realpathSync(directory + ".recovery-anchor.sqlite"));
    } finally { anchor.close(); }
    assert.deepEqual(fs.readdirSync(directory).filter(name => !/-wal$|-shm$/.test(name)).sort(), ["funding-recovery.sqlite", "wallet-nonces.sqlite"]);
    const changed = new DatabaseSync(sqlitePath(path.join(directory, "wallet-nonces.sqlite")));
    try { changed.exec("UPDATE recovery_generation SET generation=generation+1"); } finally { changed.close(); }
    assert.throws(() => new FundingRecovery(directory, options), /generation mismatch/);
  } finally { journal?.close(); guard?.close(); }
});

test("an existing ordinary-path recovery anchor reopens through Windows namespace spelling without changing identity", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-existing-journal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "journal"), files = ["probe.sqlite"];
  let guard, db;
  try {
    guard = new JournalSet(directory, { files }); db = new DatabaseSync(path.join(directory, files[0]));
    db.exec("CREATE TABLE identity(id INTEGER PRIMARY KEY,value TEXT)"); guard.attach(db);
    guard.write(db, () => db.prepare("INSERT INTO identity VALUES(1,?)").run("same record"));
    db.close(); db = null; guard.close(); guard = null;
    const readIdentity = () => {
      const anchor = new DatabaseSync(directory + ".recovery-anchor.sqlite", { readOnly: true });
      try { return { ...anchor.prepare("SELECT * FROM anchor WHERE id=1").get() }; } finally { anchor.close(); }
    };
    const before = readIdentity();
    guard = new JournalSet(path.toNamespacedPath(directory), { files });
    db = new DatabaseSync(sqlitePath(path.join(directory, files[0])));
    assert.equal(db.prepare("SELECT value FROM identity").get().value, "same record");
    assert.deepEqual(readIdentity(), before, "opening through another spelling must not reset or rewrite the anchor");
  } finally { db?.close(); guard?.close(); }
});
