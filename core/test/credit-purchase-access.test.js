"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), os = require("os"), { DatabaseSync } = require("node:sqlite");
const { installation, claimHost } = require("../../electron/credit-purchase-access"), { guardOtherJournals } = require("../../electron/credit-purchase-journals");
const P = require("../lib/koin-network/job-protocol");
function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-purchase-access-")); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const directory = path.join(dataDir, "new"); fs.mkdirSync(directory);
  const config = { owner: "fixture-wallet", schedulerUrl: "https://fixture.invalid", mode: "mainnet-pilot", deployment: { chainId: "fixture-chain" } };
  const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
  return { dataDir, directory, config, storage };
}
test("public purchase reuses only the older installation ID and preserves its credential bytes", t => {
  const f = setup(t), root = path.join(f.dataDir, "koin-prepaid-v1"); fs.mkdirSync(root);
  const file = path.join(root, "test-access.enc"), id = P.hash("original-installation"), bytes = JSON.stringify({ installation: id, credential: { owner: f.config.owner, schedulerUrl: f.config.schedulerUrl, token: "old-expired-private-token" } });
  fs.writeFileSync(file, bytes);
  assert.equal(installation(f), id); assert.equal(installation(f), id); assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.ok(!fs.readFileSync(path.join(f.directory, "purchase-installation.enc"), "utf8").includes("token"));
  assert.throws(() => installation({ ...f, config: { ...f.config, owner: "changed" } }), /identity/);
});
test("public host claim uses the current account token and rejects late revocation or mismatched lease", async t => {
  const f = setup(t), c = { config: f.config, auth: { sessionToken: "current-account-token" } }, id = P.hash("id"); let revoked = false;
  const options = { c, account: { assertCreditAuthorization: () => { if (revoked) throw Error("Signed out"); } }, wallet: { address: f.config.owner }, installation: id,
    fetchImpl: async (_url, request) => { assert.equal(request.headers.authorization, "Bearer current-account-token"); return Response.json({ mode: f.config.mode, chainId: f.config.deployment.chainId, owner: f.config.owner, installation: id, granted: true }); } };
  assert.equal((await claimHost(options)).granted, true);
  await assert.rejects(claimHost({ ...options, fetchImpl: async () => Response.json({ granted: true }) }), /lease/);
  await assert.rejects(claimHost({ ...options, fetchImpl: async (...args) => { const response = await options.fetchImpl(...args); revoked = true; return response; } }), /Signed out/);
});
test("new payment cannot bypass an unresolved older nonce and read-only checks preserve its journal", t => {
  const f = setup(t), root = path.join(f.dataDir, "koin-foundation-test", "journals"); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "wallet-nonces.sqlite"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE identity(id INTEGER PRIMARY KEY,data TEXT); CREATE TABLE reservations(owner TEXT,state TEXT)");
  db.prepare("INSERT INTO identity VALUES(1,?)").run(JSON.stringify({ chainId: f.config.deployment.chainId }));
  db.prepare("INSERT INTO reservations VALUES(?,?)").run(f.config.owner, "signed"); db.close(); const before = fs.readFileSync(file);
  assert.throws(() => guardOtherJournals(f.dataDir, f.directory, f.config), /unresolved/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.doesNotThrow(() => guardOtherJournals(f.dataDir, root, f.config));
  assert.doesNotThrow(() => guardOtherJournals(f.dataDir, f.directory, { ...f.config, owner: "other-wallet" }));
});
