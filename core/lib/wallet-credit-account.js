"use strict";
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { utils } = require("koilib");
const { testDomain } = require("./koin-network/payment-mode");
const { isProtectedStorage, storageState } = require("./protected-storage");
const fail = (code, message) => Object.assign(Error(message), { code });
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function pin(config, origin) {
  const d = config?.deployment;
  if (!d || d.product !== "prepaid-usd-v1" || new URL(config.schedulerUrl).origin !== origin) throw fail("network-changed", "The credit service does not match this wallet connection");
  return { serviceOrigin: origin, schedulerUrl: config.schedulerUrl,
    target: { chainId: d.chainId, credits: d.credits, creditsHash: d.creditsHash, domain: testDomain(d, config.schedulerUrl), policyHash: config.policyHash } };
}
function samePin(value, expected) {
  return value?.serviceOrigin === expected.serviceOrigin && value.schedulerUrl === expected.schedulerUrl &&
    value.target && Object.keys(value.target).sort().join() === Object.keys(expected.target).sort().join() &&
    Object.entries(expected.target).every(([key, val]) => value.target[key] === val);
}
function challengeHash(c) {
  return crypto.createHash("sha256").update(JSON.stringify(["KAI-WALLET-CREDIT-SESSION-V1", c.schema, c.purpose,
    c.serviceOrigin, c.schedulerUrl, c.target.chainId, c.target.credits, c.target.creditsHash, c.target.domain, c.target.policyHash,
    c.address, c.deviceId, c.freeOnly, c.nonce, c.issuedAt, c.expiresAt, c.sessionExpiresAt])).digest();
}
async function request(account, route, body, signal, token) {
  const response = await (account.fetchImpl || fetch)(account.origin() + route, { method: body === undefined ? "GET" : "POST", redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const parts = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > 65536) throw fail("service-unavailable", "Wallet connection response is too large"); parts.push(part); }
  let value; try { value = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw fail("service-upgrade-required", "Wallet connection is not available on this credit service yet"); }
  if (!response.ok || value.ok !== true) throw fail(response.status === 404 ? "service-upgrade-required" : "wallet-connection-failed", value.error || "Wallet connection is not available on this credit service yet");
  return value;
}
function online(account) {
  if (account.settings.get("network.privacyMode", "local-only") === "local-only") throw fail("online-required", "Choose an online route to use network credits");
}
async function capabilities(account, config, signal) {
  online(account);
  const expected = pin(config, account.origin()), result = await request(account, "/auth/wallet-credit/capabilities", undefined, signal), c = result.capabilities;
  if (c?.walletCredits !== 1 || c.freeOnlySessions !== 1 || c.scope !== "wallet-credits" || !samePin(c, expected) || c.challengeTtlMs !== 300000 || c.sessionTtlMs !== 2592000000)
    throw fail("service-upgrade-required", "This credit service has not enabled the verified wallet connection protocol");
  return { ...expected, challengeTtlMs: c.challengeTtlMs, sessionTtlMs: c.sessionTtlMs };
}
function device(account) {
  const file = account.file + ".device";
  let id; try { id = fs.readFileSync(file, "utf8").trim(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (id) { if (!digest(id)) throw fail("device-record-invalid", "The saved network device identity needs recovery"); return id; }
  id = crypto.randomBytes(32).toString("hex"); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, id + "\n", { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; return device(account); }
  return id;
}
async function connect(account, config, { review, sessionOnly = false } = {}, signal) {
  if (typeof review !== "function" || typeof sessionOnly !== "boolean") throw fail("native-review-required", "Connect your wallet from the desktop app");
  online(account); signal?.throwIfAborted();
  const initialToken = account._token(), address = account.wallet?.address, wallet = account.wallet?.status?.();
  if (!utils.isChecksumAddress(address || "")) throw fail("wallet-required", "Create or import a wallet to connect to network credits");
  if (!wallet?.unlocked) throw fail("wallet-unlock-required", "Unlock your wallet once to connect it to network credits");
  if (!sessionOnly && !isProtectedStorage(account.safeStorage)) throw fail("secure-storage-required", storageState(account.safeStorage).detail);
  let expectedAccountId = account._tokenRecord()?.accountId || null;
  if (initialToken) {
    try { expectedAccountId = (await account.creditAuthorization(config.schedulerUrl, signal)).accountId; }
    catch (error) {
      if (signal?.aborted) throw error;
      if (!expectedAccountId) throw fail("identity-unverified", "The existing credit account could not be verified and remains saved. Try again when the service is available, or sign out explicitly before connecting another identity");
    }
  }
  // A temporary connection can sit above an older encrypted account file.
  // Re-enabling persistent access must reconcile that hidden identity before
  // replacing it; memory-session identity alone does not authorize overwrite.
  if (!sessionOnly && (account._memorySession || account._ignoreStoredSession) && fs.existsSync(account.file)) {
    const stored = account._storedTokenRecord();
    if (!stored?.token) throw fail("saved-account-unavailable", "The earlier saved credit account is still locked or unreadable and has been preserved. Unlock its credential storage before saving this connection");
    let storedAccountId = stored.accountId;
    if (!storedAccountId) {
      let verifiedStored;
      try { verifiedStored = await request(account, "/auth/session", undefined, signal, stored.token); }
      catch { throw fail("saved-account-unavailable", "The earlier saved credit account could not be verified and has been preserved. Temporary access can continue; recover or explicitly sign out of the saved account before replacing it"); }
      storedAccountId = verifiedStored.account?.id;
    }
    if (typeof storedAccountId !== "string" || !storedAccountId || expectedAccountId && storedAccountId !== expectedAccountId)
      throw fail("identity-changed", "The earlier saved connection belongs to another credit account and has been preserved. Explicitly sign out before replacing that connection");
    expectedAccountId ||= storedAccountId;
  }
  const expected = await capabilities(account, config, signal), deviceId = device(account);
  const guard = () => {
    signal?.throwIfAborted(); online(account);
    if (address !== account.wallet?.address || initialToken !== account._token() || !account.wallet?.status?.().unlocked || (!sessionOnly && !isProtectedStorage(account.safeStorage)))
      throw fail("identity-changed", "Wallet or secure storage changed during connection; no access was saved");
  };
  guard();
  const approved = await review({ address, serviceOrigin: expected.serviceOrigin, schedulerUrl: expected.schedulerUrl,
    deviceId, sessionOnly, expiresInDays: 30, scope: "wallet-credits" });
  guard(); if (approved !== true) return { state: "cancelled" };
  const result = await request(account, "/auth/wallet-credit/challenge", { address, deviceId, freeOnly: sessionOnly }, signal), c = result.challenge, now = Date.now();
  guard();
  if (!c || Object.keys(c).sort().join() !== "address,deviceId,expiresAt,freeOnly,issuedAt,nonce,purpose,schedulerUrl,schema,serviceOrigin,sessionExpiresAt,target" ||
      c.schema !== 1 || c.purpose !== "wallet-credit-session" || !samePin(c, expected) || c.address !== address || c.deviceId !== deviceId || !digest(c.nonce) ||
      c.freeOnly !== sessionOnly ||
      ![c.issuedAt, c.expiresAt, c.sessionExpiresAt].every(Number.isSafeInteger) || Math.abs(c.issuedAt - now) > 60000 || c.expiresAt <= now ||
      c.expiresAt - c.issuedAt !== expected.challengeTtlMs || c.sessionExpiresAt - c.issuedAt !== expected.sessionTtlMs)
    throw fail("invalid-challenge", "The wallet connection challenge does not match the reviewed network or expiry");
  const signature = await account.wallet.signHash(challengeHash(c)); guard();
  const verified = await request(account, "/auth/wallet-credit/verify", { challengeId: c.nonce, signature }, signal); guard();
  const a = verified.account;
  if (verified.scope !== "wallet-credits" || verified.freeOnly !== sessionOnly || typeof verified.token !== "string" || !/^wc_[A-Za-z0-9_-]{43}$/.test(verified.token) ||
      verified.expiresAt !== c.sessionExpiresAt || typeof a?.id !== "string" || !a.id || a.id.length > 200 || a.scope !== "wallet-credits" ||
      a.freeOnly !== sessionOnly ||
      !Array.isArray(a.wallets) || a.wallets.length !== 1 || a.wallets[0].address !== address)
    throw fail("invalid-session", "The network returned a wallet connection for a different identity");
  if (expectedAccountId && a.id !== expectedAccountId) throw fail("identity-changed", "This wallet belongs to another credit account. The existing account and balance were preserved; sign out explicitly before choosing a different account");
  account._saveToken(verified.token, { scope: "wallet-credits", wallet: address, accountId: a.id, expiresAt: verified.expiresAt, freeOnly: sessionOnly }, { sessionOnly });
  account.onEvent({ type: "account:signed-in" });
  return { state: "connected", accountId: a.id, address, sessionOnly, expiresAt: verified.expiresAt };
}
module.exports = { capabilities, connect, challengeHash, pin, fail };
