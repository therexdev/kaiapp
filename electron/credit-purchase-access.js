"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const P = require("../core/lib/koin-network/job-protocol");
// Reuses an authenticated public account session; creates no account credential.
// The local installation identifier only coordinates the existing signing lease.
function installation({ dataDir, directory, config, storage }) {
  if (!storage?.isEncryptionAvailable?.()) throw Error("Unlock OS credential storage to review payment");
  const read = file => {
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 16384) throw Error("Invalid payment installation record");
    return JSON.parse(storage.decryptString(fs.readFileSync(file)));
  };
  const file = path.join(directory, "purchase-installation.enc"), identity = P.hash(JSON.stringify([config.owner, config.schedulerUrl, config.deployment.chainId]));
  if (fs.existsSync(file)) { const saved = read(file); if (saved.identity !== identity) throw Error("Payment installation identity changed"); return P.digest(saved.installation); }
  const candidates = new Set();
  for (const name of ["koin-foundation-test", "koin-prepaid-v1", "koin-prepaid-usd-v1"]) {
    const old = path.join(dataDir, name, "test-access.enc"); if (!fs.existsSync(old)) continue;
    const saved = read(old);
    if (saved.credential?.owner === config.owner && saved.credential?.schedulerUrl === config.schedulerUrl) candidates.add(P.digest(saved.installation));
  }
  if (candidates.size > 1) throw Error("Earlier wallet installations need review before payment");
  const id = candidates.values().next().value || crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, storage.encryptString(JSON.stringify({ identity, installation: id })), { mode: 0o600, flag: "wx" });
  return id;
}
async function claimHost({ c, account, wallet, installation: id, fetchImpl = fetch, signal }) {
  const guard = () => { signal?.throwIfAborted(); account.assertCreditAuthorization(c.auth, c.config.schedulerUrl); if (wallet.address !== c.config.owner) throw Error("Unlock the payment wallet linked to this account"); };
  guard();
  const response = await fetchImpl(c.config.schedulerUrl + "/koin/test/lease", { method: "POST", redirect: "error", signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(10000)]),
    headers: { "content-type": "application/json", authorization: "Bearer " + c.auth.sessionToken }, body: JSON.stringify({ installation: id, creditWallet: c.config.owner }) });
  const parts = []; let size = 0;
  for await (const part of response.body) { guard(); size += part.length; if (size > 4096) throw Error("Invalid payment host response"); parts.push(part); }
  guard(); const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!response.ok || value.mode !== c.config.mode || value.chainId !== c.config.deployment.chainId || value.owner !== c.config.owner || value.installation !== id || value.granted !== true)
    throw Error("This wallet's signing lease is unavailable. Keep the saved payment for recovery on its original computer.");
  return value;
}
module.exports = { installation, claimHost };
