"use strict";
// Isolated diagnostics only. Never reads or moves any application journals.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { pathToFileURL } = require("node:url");
const { DatabaseSync } = require("node:sqlite"), { JournalSet } = require("../core/lib/koin-network/journal-set");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-sqlite-path-")), results = [];
function nested(label, minimum) {
  let directory = path.join(root, label);
  while ((directory + path.sep + "probe.sqlite").length < minimum) directory = path.join(directory, "nested-" + "x".repeat(35));
  fs.mkdirSync(directory, { recursive: true }); return directory;
}
try {
  for (const minimum of [220, 260, 300, 500]) for (const form of ["ordinary", "namespaced", "file-url", "longpath-vfs-uri"]) {
    const directory = nested(minimum + "-" + form, minimum), file = path.join(directory, "probe.sqlite");
    const input = form === "namespaced" ? path.toNamespacedPath(file) : form === "file-url" ? pathToFileURL(file)
      : form === "longpath-vfs-uri" ? pathToFileURL(file).href + "?vfs=" + (process.platform === "win32" ? "win32-longpath" : "unix") : file;
    let db;
    try {
      db = new DatabaseSync(input); db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');");
      db.close(); db = null; db = new DatabaseSync(input);
      if (db.prepare("SELECT value FROM probe").get().value !== "preserved") throw Error("Data failed to reopen");
      results.push({ kind: "sqlite", minimum, form, pathLength: file.length, realPathLength: fs.realpathSync(file).length, ok: true });
    } catch (error) { results.push({ kind: "sqlite", minimum, form, pathLength: file.length, ok: false, code: error.code, message: error.message }); }
    finally { db?.close(); }
  }
  for (const minimum of [180, 260, 300]) for (const form of ["ordinary", "namespaced"]) {
    const directory = nested(minimum + "-journal-" + form, minimum), journal = path.join(directory, "journals");
    const input = form === "namespaced" ? path.toNamespacedPath(journal) : journal, backup = path.join(root, "backup-" + minimum + "-" + form);
    let guard, db, stage = "anchor";
    try {
      guard = new JournalSet(input, { files: ["probe.sqlite"] });
      stage = "attach-and-write"; db = new DatabaseSync(path.join(input, "probe.sqlite"));
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE identity(id INTEGER PRIMARY KEY,value TEXT)"); guard.attach(db);
      guard.write(db, () => db.prepare("INSERT INTO identity VALUES(1,?)").run("preserved"));
      stage = "snapshot"; const snapshot = guard.snapshot(backup);
      if (snapshot.files.length !== 1 || !guard.inspect(backup).restorable) throw Error("Snapshot did not preserve the journal generation");
      db.close(); db = null; guard.close(); guard = null;
      stage = "ordinary-path-reopen"; guard = new JournalSet(journal, { files: ["probe.sqlite"] }); guard.close(); guard = null;
      stage = "namespaced-path-reopen"; guard = new JournalSet(path.toNamespacedPath(journal), { files: ["probe.sqlite"] }); guard.close(); guard = null;
      stage = "restore"; guard = new JournalSet(input, { files: ["probe.sqlite"], maintenance: true }); guard.restore(backup);
      db = new DatabaseSync(path.join(input, "probe.sqlite"));
      if (db.prepare("SELECT value FROM identity").get().value !== "preserved") throw Error("Restored data differs");
      results.push({ kind: "journal-identity-and-backup", form, pathLength: (journal + ".recovery-anchor.sqlite").length, ok: true });
    } catch (error) { results.push({ kind: "journal-identity-and-backup", form, stage, pathLength: (journal + ".recovery-anchor.sqlite").length, ok: false, code: error.code, message: error.message }); }
    finally { db?.close(); guard?.close(); }
  }
  console.log(JSON.stringify({ platform: process.platform, node: process.version, sqlite: process.versions.sqlite, rootLength: root.length, physicalRootLength: fs.realpathSync(root).length, results }, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
