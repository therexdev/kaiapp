"use strict";
const fs = require("fs"), path = require("path"), { DatabaseSync } = require("node:sqlite");
const { sqlitePath } = require("../core/lib/sqlite-path");
const { isDeepStrictEqual } = require("node:util");
function directories(dataDir) {
  const result = ["koin-foundation-test", "koin-prepaid-v1", "koin-prepaid-usd-v1"].map(name => path.join(dataDir, name, "journals"));
  const root = path.join(dataDir, "credit-account-v2");
  if (fs.existsSync(root)) {
    if (fs.lstatSync(root).isSymbolicLink()) throw Error("Review linked credit records before payment");
    const accounts = fs.readdirSync(root, { withFileTypes: true }); if (accounts.length > 256) throw Error("Too many saved credit accounts; review before payment");
    for (const account of accounts) {
      if (!/^[a-f0-9]{64}$/.test(account.name)) continue;
      if (!account.isDirectory()) throw Error("Invalid saved credit account directory");
      const dir = path.join(root, account.name), contexts = fs.readdirSync(dir, { withFileTypes: true });
      if (contexts.length > 256) throw Error("Too many saved credit configurations; review before payment");
      for (const context of contexts) {
        if (!/^[a-f0-9]{64}$/.test(context.name)) continue;
        if (!context.isDirectory()) throw Error("Invalid saved credit configuration directory");
        result.push(path.join(dir, context.name, "journals"));
      }
    }
  }
  return result;
}
function read(file, run) {
  if (fs.lstatSync(file).isSymbolicLink()) throw Error("Review linked payment journals before payment");
  const db = new DatabaseSync(sqlitePath(file), { readOnly: true });
  try { if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw Error("Recover damaged payment journal before payment"); return run(db); }
  finally { db.close(); }
}
function guardOtherJournals(dataDir, current, config) {
  for (const dir of directories(dataDir)) {
    if (path.resolve(dir) === path.resolve(current) || !fs.existsSync(dir)) continue;
    if (fs.lstatSync(dir).isSymbolicLink()) throw Error("Review linked payment journals before payment");
    for (const [filename, table, states] of [["wallet-nonces.sqlite", "reservations", ["signing", "signed"]], ["funding-recovery.sqlite", "deposits", ["signing", "staged", "unknown", "needs_review"]]]) {
      const file = path.join(dir, filename); if (!fs.existsSync(file)) continue;
      read(file, db => {
        const identity = JSON.parse(db.prepare("SELECT data FROM identity WHERE id=1").get()?.data || "null");
        const chain = identity?.chainId || identity?.deployment?.chainId;
        if (!chain) throw Error("Recover missing earlier payment identity before payment");
        if (chain !== config.deployment.chainId) return;
        const pending = db.prepare(`SELECT state FROM ${table} WHERE owner=?`).all(config.owner);
        if (pending.some(row => states.includes(row.state))) throw Error("An earlier wallet transaction is unresolved. Recover it in older account details before starting another payment.");
      });
    }
  }
}
function purchaseDirectory(dataDir, directory, config) {
  const old = path.join(dataDir, "koin-prepaid-usd-v1"), manifest = path.join(old, "deployment.json"), journals = path.join(old, "journals");
  if (fs.existsSync(manifest) && fs.existsSync(journals)) {
    if (fs.lstatSync(manifest).isSymbolicLink() || fs.statSync(manifest).size > 16384) throw Error("Review earlier USD payment configuration");
    const saved = require("./koin-test-config").configuration(JSON.parse(fs.readFileSync(manifest, "utf8")));
    if (isDeepStrictEqual(saved, config)) return journals;
  }
  return path.join(directory, "journals");
}
module.exports = { guardOtherJournals, purchaseDirectory };
