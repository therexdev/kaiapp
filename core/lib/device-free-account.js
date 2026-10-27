"use strict";
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const { pin } = require("./wallet-credit-account");
const samePin = (value, expected) => value?.serviceOrigin === expected.serviceOrigin && value.schedulerUrl === expected.schedulerUrl &&
  value.target && Object.keys(value.target).sort().join() === Object.keys(expected.target).sort().join() &&
  Object.entries(expected.target).every(([key, item]) => value.target[key] === item);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = (code, text) => Object.assign(Error(text), { code });
const CHALLENGE_TTL = 300000, SESSION_TTL = 86400000;
const identityError = () => fail("device-identity-unavailable", "This installation's free-access identity could not be read safely. Its existing file has been preserved.");
function challengeHash(c) {
  return crypto.createHash("sha256").update(JSON.stringify(["KAI-DEVICE-FREE-SESSION-V1", c.schema, c.purpose,
    c.serviceOrigin, c.schedulerUrl, c.target.chainId, c.target.credits, c.target.creditsHash, c.target.domain, c.target.policyHash,
    c.publicKey, c.nonce, c.issuedAt, c.expiresAt, c.sessionExpiresAt])).digest();
}
function accountId(expected, publicKey) {
  const targetHash = hash(JSON.stringify([expected.serviceOrigin, expected.schedulerUrl, expected.target]));
  return "guest_" + hash(JSON.stringify(["KAI-DEVICE-FREE-IDENTITY-V1", targetHash, publicKey]));
}
function checkMode(stat, directory = false) {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw identityError();
}
function syncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, "r"); fs.fsyncSync(fd); }
  catch (error) { if (process.platform !== "win32" || !["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readIdentity(file) {
  const before = fs.lstatSync(file); checkMode(before);
  if (before.size < 100 || before.size > 4096) throw identityError();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const actual = fs.fstatSync(fd); checkMode(actual);
    if (actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) throw identityError();
    // Bound the allocation even if another process grows the file after stat.
    const buffer = Buffer.alloc(before.size + 1); let length = 0, count;
    do { count = fs.readSync(fd, buffer, length, buffer.length - length, null); length += count; } while (count > 0 && length < buffer.length);
    if (length !== before.size) throw identityError(); bytes = buffer.subarray(0, length);
  } finally { fs.closeSync(fd); }
  let value, privateKey, publicKey;
  try {
    value = JSON.parse(bytes.toString("utf8"));
    if (Object.keys(value).sort().join() !== "algorithm,privateKey,publicKey,schema" || value.schema !== 1 || value.algorithm !== "Ed25519" ||
        typeof value.privateKey !== "string" || typeof value.publicKey !== "string") throw identityError();
    const der = Buffer.from(value.privateKey, "base64");
    try {
      if (der.length !== 48 || der.toString("base64") !== value.privateKey) throw identityError();
      privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    } finally { der.fill(0); }
    if (privateKey.asymmetricKeyType !== "ed25519") throw identityError();
    publicKey = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64");
    if (publicKey !== value.publicKey || Buffer.from(publicKey, "base64").length !== 44) throw identityError();
  } catch { throw identityError(); }
  return { privateKey, publicKey, digest: hash(bytes) };
}

// This key identifies a free-only installation. It is not a KOIN wallet and
// cannot buy credits, spend purchased credit, authorize a provider, or access
// another account. Keep its credential file private; never persist the bearer
// session or chat contents alongside it, and never use basic_text encryption.
class DeviceFreeAccount {
  constructor({ dataDir, settings, config, fetchImpl = fetch, clock = Date.now }) {
    const origin = new URL(config.schedulerUrl).origin;
    this.expected = pin(config, origin);
    this.directory = path.join(dataDir, "network-free-access");
    this.file = path.join(this.directory, hash(origin) + ".json");
    Object.assign(this, { settings, fetchImpl, clock });
    this.identity = null; this.session = null; this.pending = null; this.generation = 0;
    this.failures = 0; this.retryAt = 0; this.closed = false;
  }
  online(schedulerUrl = this.expected.schedulerUrl) {
    if (this.closed) throw fail("free-access-ended", "This free-access session has ended.");
    if (schedulerUrl !== this.expected.schedulerUrl) throw fail("network-changed", "Free access belongs to a different network.");
    if (this.settings?.get?.("network.privacyMode", "local-only") === "local-only") throw fail("online-required", "Choose Network to use free credits.");
  }
  loadIdentity() {
    this.online();
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); checkMode(fs.lstatSync(this.directory), true);
      let loaded;
      try { loaded = readIdentity(this.file); }
      catch (error) {
        if (error.code !== "ENOENT" || this.identity) throw error;
        const pair = crypto.generateKeyPairSync("ed25519"), value = { schema: 1, algorithm: "Ed25519",
          privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
          publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
        const temporary = path.join(this.directory, ".identity-" + crypto.randomBytes(16).toString("hex") + ".tmp");
        let created = false;
        try {
          const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
          created = true;
          try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); }
          finally { fs.closeSync(fd); }
          // Link is an atomic no-replace publication; a concurrent startup
          // uses the first durable identity instead of overwriting its key.
          try { fs.linkSync(temporary, this.file); syncDirectory(this.directory); }
          catch (error) { if (error.code !== "EEXIST") throw error; }
        } finally { if (created) fs.unlinkSync(temporary); }
        loaded = readIdentity(this.file);
      }
      if (this.identity && loaded.digest !== this.identity.digest) throw identityError();
      this.identity = loaded; return loaded;
    } catch (error) { if (error.code === "device-identity-unavailable") throw error; throw identityError(); }
  }
  async request(route, body, signal, token) {
    this.online(); signal.throwIfAborted();
    const response = await this.fetchImpl(this.expected.serviceOrigin + route, { method: body === undefined ? "GET" : "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    this.online(); signal.throwIfAborted();
    const chunks = []; let size = 0;
    for await (const chunk of response.body || []) {
      signal.throwIfAborted(); size += chunk.length;
      if (size > 65536) throw fail("free-access-unavailable", "The free-access service returned an invalid response.");
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail("free-access-unavailable", "The free-access service returned an invalid response."); }
    if (!response.ok || value.ok !== true) throw fail(response.status === 404 ? "service-upgrade-required" : "free-access-unavailable",
      response.status === 404 ? "Automatic free access is not enabled on this network yet." : "Free network access is temporarily unavailable. Retrying shortly.");
    return value;
  }
  async connect(pending) {
    const signal = AbortSignal.any([pending.controller.signal, AbortSignal.timeout(15000)]), epoch = this.generation;
    const identity = this.loadIdentity(), expected = this.expected, id = accountId(expected, identity.publicKey);
    const guard = () => { this.online(); signal.throwIfAborted(); if (epoch !== this.generation || this.loadIdentity().digest !== identity.digest) throw fail("identity-changed", "Free-access setup changed. No access was retained."); };
    const c = (await this.request("/auth/device-free/capabilities", undefined, signal)).capabilities; guard();
    if (c?.deviceFreeCredits !== 1 || c.scope !== "device-free" || c.freeOnly !== true || c.algorithm !== "Ed25519" || !samePin(c, expected) ||
        c.challengeTtlMs !== CHALLENGE_TTL || c.sessionTtlMs !== SESSION_TTL) throw fail("service-upgrade-required", "This network has not enabled verified automatic free access.");
    const challenge = (await this.request("/auth/device-free/challenge", { publicKey: identity.publicKey }, signal)).challenge; guard();
    const now = this.clock();
    if (!challenge || Object.keys(challenge).sort().join() !== "expiresAt,issuedAt,nonce,publicKey,purpose,schedulerUrl,schema,serviceOrigin,sessionExpiresAt,target" ||
        challenge.schema !== 1 || challenge.purpose !== "device-free-session" || !samePin(challenge, expected) || challenge.publicKey !== identity.publicKey ||
        typeof challenge.nonce !== "string" || !/^[a-f0-9]{64}$/.test(challenge.nonce) ||
        ![challenge.issuedAt, challenge.expiresAt, challenge.sessionExpiresAt].every(Number.isSafeInteger) || Math.abs(challenge.issuedAt - now) > 60000 || challenge.expiresAt <= now ||
        challenge.expiresAt - challenge.issuedAt !== CHALLENGE_TTL || challenge.sessionExpiresAt - challenge.issuedAt !== SESSION_TTL)
      throw fail("invalid-challenge", "The automatic free-access challenge did not match this installation or network.");
    const signature = crypto.sign(null, challengeHash(challenge), identity.privateKey).toString("base64"); guard();
    const result = await this.request("/auth/device-free/verify", { challengeId: challenge.nonce, signature }, signal); guard();
    const account = result.account;
    if (result.scope !== "device-free" || result.freeOnly !== true || typeof result.token !== "string" || !/^df_[A-Za-z0-9_-]{43}$/.test(result.token) ||
        result.expiresAt !== challenge.sessionExpiresAt || account?.id !== id || account.scope !== "device-free" || account.freeOnly !== true ||
        account.expiresAt !== result.expiresAt || !Array.isArray(account.wallets) || account.wallets.length !== 0)
      throw fail("invalid-session", "The network returned free access for a different installation or account.");
    const auth = { sessionToken: result.token, accountId: id, owner: "account-" + hash("verified-account:" + id), localWallet: null,
      schedulerUrl: expected.schedulerUrl, sessionOnly: true, freeOnly: true, scope: "device-free", deviceFree: true, expiresAt: result.expiresAt };
    this.session = Object.freeze(auth); this.failures = 0; this.retryAt = 0;
    return { ...auth };
  }
  async creditAuthorization(schedulerUrl, signal) {
    this.online(schedulerUrl); signal?.throwIfAborted();
    if (this.session && this.session.expiresAt > this.clock() + 1000) {
      this.assertCreditAuthorization(this.session, schedulerUrl); return { ...this.session };
    }
    this.session = null;
    if (this.clock() < this.retryAt) throw fail("free-access-unavailable", "Free network access is temporarily unavailable. Retrying shortly.");
    if (!this.pending) {
      const pending = { controller: new AbortController(), waiters: new Set(), promise: null };
      this.pending = pending;
      pending.promise = Promise.resolve().then(() => this.connect(pending)).catch(error => {
        if (!pending.controller.signal.aborted) { this.failures++; this.retryAt = this.clock() + Math.min(30000, 5000 * 2 ** Math.min(this.failures - 1, 3)); }
        throw error;
      }).finally(() => { if (this.pending === pending) this.pending = null; });
      pending.promise.catch(() => {});
    }
    const pending = this.pending, waiter = {}; pending.waiters.add(waiter);
    let abort;
    try {
      const result = signal ? await Promise.race([pending.promise, new Promise((_, reject) => {
        abort = () => reject(signal.reason || new DOMException("Free-access request stopped", "AbortError"));
        signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      })]) : await pending.promise;
      signal?.throwIfAborted(); this.assertCreditAuthorization(result, schedulerUrl); return result;
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
      pending.waiters.delete(waiter);
      if (!pending.waiters.size && this.pending === pending) pending.controller.abort(new DOMException("Free-access setup stopped", "AbortError"));
    }
  }
  assertCreditAuthorization(auth, schedulerUrl) {
    this.online(schedulerUrl);
    if (!this.session || this.session.expiresAt <= this.clock() || !auth || Object.keys(this.session).some(key => auth[key] !== this.session[key]) ||
        Object.keys(auth).length !== Object.keys(this.session).length) throw fail("free-access-ended", "Free access has expired or changed. Reconnecting is required.");
    this.loadIdentity(); return auth;
  }
  clear() {
    this.generation++; this.session = null; this.retryAt = 0; this.failures = 0;
    const pending = this.pending; this.pending = null; pending?.controller.abort(new DOMException("Free-access session ended", "AbortError"));
  }
  invalidate(auth) { if (auth?.sessionToken && auth.sessionToken === this.session?.sessionToken) this.clear(); }
  dispose() { this.clear(); this.closed = true; this.identity = null; }
}
module.exports = { DeviceFreeAccount, challengeHash, accountId };
