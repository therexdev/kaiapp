"use strict";
const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const P = require("../core/lib/koin-network/provider-device-protocol"), Models = require("./credit-models");
const { isProtectedStorage, storageState } = require("../core/lib/protected-storage");
const error = (code, message) => Object.assign(Error(message), { code });
function target(config) {
  const d = config.deployment;
  return require("../core/lib/koin-network/session-delegation").target({ chainId: d.chainId, credits: d.credits, creditsHash: d.creditsHash, policyHash: config.policyHash,
    domain: require("../core/lib/koin-network/payment-mode").testDomain(d, config.schedulerUrl) });
}
class ProviderDevice {
  constructor({ service, core, dialog, clock = Date.now }) {
    this.storage = require("../core/lib/wallet-credential-vault").scopedStorage((core.creditAccount || core.account)?.safeStorage, "provider-device");
    Object.assign(this, { service, core, dialog, clock }); this.records = new Map(); this.lastActionAt = new Map(); this.generation = 0; this.busy = false;
  }
  identity() {
    if (this.service.service?.state !== "ready") throw error("backend-upgrade-required", "Earning service setup is unavailable. Your wallet and existing records are preserved.");
    const wallet = this.core.account.wallet, owner = wallet?.address;
    if (this.identityOwner !== undefined && this.identityOwner !== owner) this.dispose();
    this.identityOwner = owner;
    if (!owner) throw error("wallet-required", "Create a wallet or use your existing wallet to receive KOIN earnings.");
    if (this.core.gateway.network.status?.().privacyMode === "local-only" || this.core.settings?.get?.("network.privacyMode") === "local-only") throw error("network-required", "Choose Network or Local-First to enable earning.");
    const config = { ...this.service.service.config, owner }, pinned = target(config);
    const identity = P.hash(JSON.stringify([config.schedulerUrl, pinned, owner])).toString("hex");
    return { config, target: pinned, identity, directory: path.join(this.service.dataDir, "provider-devices-v1", identity) };
  }
  async request(c, route, body, signal, max = 262144) {
    signal?.throwIfAborted();
    const response = await this.service.fetchImpl(c.config.schedulerUrl + "/koin/provider/device/" + route, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(10000)]),
      headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { signal?.throwIfAborted(); size += chunk.length; if (size > max) throw Error("Provider service response is too large"); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch {
      if (response.status === 404) throw error("backend-upgrade-required", "The network needs its wallet-first earning update before this device can be authorized.");
      throw error("network-unavailable", "The earning service did not return a valid response. Your saved device authorization is preserved; reconnect when the service is available.");
    }
    if (!response.ok || value.ok === false) {
      if (response.status === 404) throw error("backend-upgrade-required", "The network needs its wallet-first earning update before this device can be authorized.");
      if (response.status === 409 && value.code === "PROVIDER_CHALLENGE_EXPIRED") throw error("authorization-challenge-expired", "The earlier device authorization was not enrolled before its challenge expired. Review a new authorization to continue.");
      if (response.status === 401 && value.code === "PROVIDER_AUTHORIZATION_REQUIRED") {
        if (c.record?.enrolled && route !== "enroll") { c.record.revoked = true; this.save(c, c.record); }
        throw error("authorization-revoked", "This device authorization is no longer accepted. Enable earning again to review a new authorization.");
      }
      throw Error(String(value.error || "The earning service is temporarily unavailable").slice(0, 300));
    }
    return value;
  }
  async capabilities(c, signal) {
    const value = await this.request(c, "capabilities", undefined, signal);
    if (value.capabilities?.walletFirstEarning !== 1 || value.capabilities?.delegatedProvider !== 1 || value.schedulerUrl !== c.config.schedulerUrl ||
        JSON.stringify(require("../core/lib/koin-network/session-delegation").target(value.target)) !== JSON.stringify(c.target))
      throw error("backend-upgrade-required", "The network has not enabled this wallet-first earning protocol for the selected deployment.");
    return value;
  }
  read(c) {
    let record = this.records.get(c.identity);
    if (record) return record;
    const file = path.join(c.directory, "authorization.enc");
    if (!fs.existsSync(file)) return null;
    if (!isProtectedStorage(this.storage)) throw error("secure-storage-required", storageState(this.storage).detail);
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 32768) throw error("authorization-recovery-required", "The saved earning authorization needs recovery; it has been preserved.");
    try { record = JSON.parse(this.storage.decryptString(fs.readFileSync(file))); }
    catch { throw error("secure-storage-required", "Unlock the wallet or recover the original protected storage to resume earning. The saved device authorization is preserved."); }
    this.validateRecord(c, record); this.records.set(c.identity, record); return record;
  }
  validateRecord(c, record) {
    if (!record || record.schema !== 1 || typeof record.enrolled !== "boolean" || typeof record.sessionOnly !== "boolean" || typeof record.privateKey !== "string") throw error("authorization-recovery-required", "The saved earning authorization needs recovery.");
    P.verifyWalletAuthorization(record.authorization, record.walletSignature, { schedulerUrl: c.config.schedulerUrl, target: c.target, wallet: c.config.owner });
    const key = crypto.createPrivateKey({ key: Buffer.from(record.privateKey, "base64"), type: "pkcs8", format: "der" });
    if (key.asymmetricKeyType !== "ed25519" || crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64") !== record.authorization.publicKey)
      throw error("authorization-recovery-required", "The saved earning key does not match its authorization.");
    return key;
  }
  save(c, record) {
    this.validateRecord(c, record);
    const idFile = path.join(c.directory, "device-id.json"), deviceId = record.authorization.deviceId;
    if (fs.existsSync(idFile) && this.deviceId(c) !== deviceId) throw Error("The earning device identity changed");
    if (!record.sessionOnly) {
      const storage = this.storage;
      if (!isProtectedStorage(storage)) throw error("secure-storage-required", storageState(storage).detail);
      fs.mkdirSync(c.directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(c.directory).isSymbolicLink()) throw Error("Provider directory must not be a symbolic link");
      const file = path.join(c.directory, "authorization.enc"), temp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error("Provider authorization must not be a symbolic link");
      // Cached keys do not authorize replacing an unreadable OS-protected
      // record when its keyring disappears during this process.
      if (fs.existsSync(file)) {
        if (fs.statSync(file).size > 32768) throw Error("Saved earning authorization needs recovery and has been preserved");
        this.validateRecord(c, JSON.parse(storage.decryptString(fs.readFileSync(file))));
      }
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, storage.encryptString(JSON.stringify(record))); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (fs.existsSync(file)) {
        const previous = this.records.get(c.identity);
        if (previous && P.authorizationId(previous.authorization) !== P.authorizationId(record.authorization)) {
          const archived = file + ".retired-" + P.authorizationId(previous.authorization);
          if (!fs.existsSync(archived)) fs.copyFileSync(file, archived, fs.constants.COPYFILE_EXCL);
        }
      }
      fs.renameSync(temp, file);
    } else fs.mkdirSync(c.directory, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(idFile)) fs.writeFileSync(idFile, JSON.stringify({ schema: 1, identity: c.identity, deviceId }), { mode: 0o600, flag: "wx" });
    this.migratePreference(c);
    this.records.set(c.identity, record);
  }
  deviceId(c) {
    const file = path.join(c.directory, "device-id.json");
    if (!fs.existsSync(file)) return crypto.randomBytes(32).toString("hex");
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4096) throw Error("The saved earning device identity needs recovery");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value.schema !== 1 || value.identity !== c.identity || !/^[a-f0-9]{64}$/.test(value.deviceId)) throw Error("The saved earning device identity needs recovery");
    return value.deviceId;
  }
  migratePreference(c) {
    const destination = path.join(c.directory, "provider-preference.json"), root = path.join(this.service.dataDir, "credit-account-v2");
    if (fs.existsSync(destination) || !fs.existsSync(root)) return;
    const candidates = [];
    for (const account of fs.readdirSync(root, { withFileTypes: true }).slice(0, 1024)) {
      if (!account.isDirectory() || !/^[a-f0-9]{64}$/.test(account.name)) continue;
      const accountDir = path.join(root, account.name);
      for (const entry of fs.readdirSync(accountDir, { withFileTypes: true }).slice(0, 1024)) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const directory = path.join(accountDir, entry.name), metadata = path.join(directory, "context.json"), preference = path.join(directory, "provider-preference.json");
        if (![metadata, preference].every(file => fs.existsSync(file) && !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).size <= 16384)) continue;
        let saved, setting;
        try { saved = JSON.parse(fs.readFileSync(metadata, "utf8")); setting = JSON.parse(fs.readFileSync(preference, "utf8")); }
        catch { continue; }
        if (saved.config?.owner !== c.config.owner || saved.config?.schedulerUrl !== c.config.schedulerUrl) continue;
        try { if (JSON.stringify(target(saved.config)) !== JSON.stringify(c.target)) continue; } catch { continue; }
        if (setting.schema !== 1 || typeof setting.enabled !== "boolean" || setting.model !== undefined && !/^[a-zA-Z0-9._-]{1,100}$/.test(setting.model)) continue;
        const selection = setting.selection;
        if (selection !== undefined && (!selection || !["all", "selected"].includes(selection.mode) || !Array.isArray(selection.models) || selection.models.length > 64 ||
            selection.models.some(id => typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(id)) || new Set(selection.models).size !== selection.models.length ||
            (selection.mode === "all" ? selection.models.length !== 0 : !selection.models.length))) continue;
        candidates.push({ setting: { schema: 1, enabled: setting.enabled, ...(setting.model ? { model: setting.model } : {}), ...(selection ? { selection } : {}) }, at: fs.statSync(preference).mtimeMs });
      }
    }
    // Public preference data only: no account credential, credit balance or
    // payment journal is copied or remapped to the provider's independent scope.
    candidates.sort((a, b) => b.at - a.at);
    if (candidates.length) fs.writeFileSync(destination, JSON.stringify(candidates[0].setting), { mode: 0o600, flag: "wx" });
  }
  assert(c, signal) {
    signal?.throwIfAborted();
    const current = this.identity();
    if (current.identity !== c.identity || this.generation !== c.generation) throw error("authorization-required", "The reward wallet or earning authorization changed. Enable earning for the current wallet.");
    const record = this.read(c);
    if (!record || record !== c.record) throw error("authorization-required", "The reward wallet or earning authorization changed. Enable earning for the current wallet.");
    if (record.revoked) throw error("authorization-revoked", "This device authorization was revoked. Enable earning again to authorize this computer.");
    if (!record.enrolled) throw error("authorization-required", "Finish authorizing this device to enable earning.");
    if (!record.sessionOnly && !isProtectedStorage(this.storage)) throw error("secure-storage-required", storageState(this.storage).detail);
    if (record.authorization.expiresAt <= this.clock()) throw error("authorization-expired", "This device's earning authorization expired. Enable earning again to review a new authorization.");
  }
  proof(c, action, digest) {
    this.assert(c);
    const id = P.authorizationId(c.record.authorization), at = Math.max(this.clock(), (this.lastActionAt.get(id) || 0) + 1);
    if (at > this.clock() + 5000) throw Error("Provider signing is temporarily rate limited");
    const result = P.encodeAction(c.record.authorization, c.record.walletSignature, this.validateRecord(c, c.record), action, digest, at);
    this.lastActionAt.set(id, at); return result;
  }
  async context(signal) {
    const c = this.identity(), record = this.read(c);
    if (!record) {
      await this.capabilities(c, signal);
      throw error("authorization-required", "Enable earning once to authorize this computer. No email or password account is required.");
    }
    Object.assign(c, { record, generation: this.generation, auth: { sessionToken: "provider:" + P.authorizationId(record.authorization) }, providerDevice: true });
    this.assert(c, signal);
    c.flow = { models: async nextSignal => { this.assert(c, nextSignal); const value = await this.capabilities(c, nextSignal); this.assert(c, nextSignal); return Models.catalog(value.catalog, c.config, this.clock()); } };
    c.access = { authorize: () => { this.assert(c); return c.auth; }, readStatus: nextSignal => this.status(c, nextSignal) };
    c.signer = this.signer(c); return c;
  }
  async authorize(window, input = {}, signal) {
    if (!input || Object.keys(input).some(k => k !== "sessionOnly") || input.sessionOnly !== undefined && typeof input.sessionOnly !== "boolean") throw Error("Choose protected storage or this session only");
    if (this.busy) throw Error("Earning authorization is already in progress");
    this.busy = true;
    try {
      const c = this.identity(), generation = this.generation; await this.capabilities(c, signal);
      const sessionOnly = input.sessionOnly === true;
      if (!sessionOnly && !isProtectedStorage(this.storage)) throw error("secure-storage-required", storageState(this.storage).detail);
      let existing;
      try { existing = this.read(c); }
      catch (e) {
        // An explicitly selected in-memory session may replace this device's
        // authority after a fresh wallet review without opening or overwriting
        // its protected record. The stable public device ID is retained.
        if (!sessionOnly || e.code !== "secure-storage-required") throw e;
      }
      if (existing && !existing.enrolled && !existing.revoked && existing.authorization.expiresAt > this.clock()) {
        try { return await this.completeEnrollment(c, existing, signal, generation); }
        catch (e) {
          if (!["authorization-challenge-expired", "authorization-revoked"].includes(e.code)) throw e;
          existing.revoked = true; this.save(c, existing);
        }
      }
      if (existing?.enrolled && !existing.revoked && existing.authorization.expiresAt > this.clock()) {
        try {
          const active = await this.context(signal); await this.status(active, signal);
          return { state: "authorized", sessionOnly: existing.sessionOnly, expiresAt: existing.authorization.expiresAt };
        } catch (e) { if (e.code !== "authorization-revoked") throw e; }
      }
      if (!this.core.account.wallet.status().unlocked) throw error("wallet-required", "Unlock the reward wallet once to authorize this device. You can lock it again while earning.");
      const pair = crypto.generateKeyPairSync("ed25519"), deviceId = existing?.authorization.deviceId || this.deviceId(c), publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const response = await this.request(c, "challenge", { wallet: c.config.owner, deviceId, publicKey }, signal, 16384);
      const authorization = P.validateAuthorization(response.authorization, { schedulerUrl: c.config.schedulerUrl, target: c.target, wallet: c.config.owner });
      if (authorization.deviceId !== deviceId || authorization.publicKey !== publicKey || authorization.issuedAt > this.clock() + 5000 || authorization.challengeExpiresAt <= this.clock()) throw Error("The earning authorization challenge changed or expired");
      const options = { type: "question", buttons: ["Cancel", "Enable earning"], defaultId: 0, cancelId: 0, noLink: true,
        title: "Enable earning on this computer", message: "Authorize this computer to earn KOIN",
        detail: `Reward wallet: ${c.config.owner}\nService: ${c.config.schedulerUrl}\nNetwork: ${c.config.deployment.network || c.config.mode}\nExpires: ${new Date(authorization.expiresAt).toISOString()}\n\nThis separate device key can share selected models and sign assigned work. It cannot spend KOIN, buy credits, change your payout address, or unlock your wallet. You can stop earning or revoke this device in Earn.\n\n${sessionOnly ? "Session only: the key stays in memory and earning must be enabled again after quitting." : "The device key is stored in this computer's protected credential storage; earning can continue when the wallet is locked."}` };
      if (!this.dialog?.showMessageBox) throw Error("Native earning authorization review is unavailable");
      const approved = await (window ? this.dialog.showMessageBox(window, options) : this.dialog.showMessageBox(options));
      signal?.throwIfAborted();
      if (approved.response !== 1) return { state: "cancelled" };
      if (generation !== this.generation || this.identity().identity !== c.identity) throw Error("Earning authorization cancelled because the wallet changed");
      const walletSignature = await this.core.account.wallet.signHash(P.authorizationHash(authorization));
      signal?.throwIfAborted(); if (generation !== this.generation || this.identity().identity !== c.identity) throw Error("Earning authorization cancelled");
      const record = { schema: 1, authorization, walletSignature, privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), sessionOnly, enrolled: false };
      this.save(c, record);
      return await this.completeEnrollment(c, record, signal, generation);
    } finally { this.busy = false; }
  }
  async completeEnrollment(c, record, signal, generation) {
    const { authorization, walletSignature, sessionOnly } = record, at = this.clock();
    const signature = crypto.sign(null, P.actionHash(authorization, "register", P.authorizationHash(authorization), at), this.validateRecord(c, record)).toString("base64");
    const enrolled = await this.request(c, "enroll", { authorization, walletSignature, at, signature }, signal, 16384);
    if (enrolled.authorizationId !== P.authorizationId(authorization) || enrolled.deviceId !== authorization.deviceId || enrolled.wallet !== c.config.owner) throw Error("The service returned a different earning authorization");
    if (generation !== this.generation || this.identity().identity !== c.identity) throw Error("Earning authorization cancelled");
    record.enrolled = true; this.save(c, record);
    return { state: "authorized", sessionOnly, expiresAt: authorization.expiresAt };
  }
  async status(c, signal) {
    this.assert(c, signal); const id = P.authorizationId(c.record.authorization);
    const value = await this.request(c, "status", { signature: this.proof(c, "status", P.hash("status:" + id)) }, signal, 262144);
    this.assert(c, signal); return value;
  }
  async revoke(window, signal) {
    const c = await this.context(signal);
    if (!this.dialog?.showMessageBox) throw Error("Native device revocation review is unavailable");
    const options = { type: "question", title: "Revoke earning device", message: "Revoke this computer's earning authorization?", detail: "This device will stop earning. Your reward wallet, credits, payment records, and other authorized devices remain unchanged.", buttons: ["Cancel", "Revoke device"], defaultId: 0, cancelId: 0, noLink: true };
    const answer = await (window ? this.dialog.showMessageBox(window, options) : this.dialog.showMessageBox(options));
    if (answer.response !== 1) return { state: "cancelled" };
    const id = P.authorizationId(c.record.authorization);
    await this.request(c, "revoke", { signature: this.proof(c, "revoke", P.hash("revoke:" + id)) }, signal, 4096);
    this.generation++; this.records.delete(c.identity);
    const file = path.join(c.directory, "authorization.enc"); if (fs.existsSync(file)) fs.renameSync(file, file + ".revoked-" + this.clock());
    return { state: "revoked" };
  }
  signer(c) {
    let assigned = null;
    const matches = job => {
      this.assert(c);
      if (!assigned || JSON.stringify(job) !== JSON.stringify(assigned)) throw Error("The device can sign only its currently assigned job");
    };
    return Object.freeze({ address: c.config.owner, deviceId: c.record.authorization.deviceId,
      register: body => { if (body.address !== c.config.owner) throw Error("Provider reward address changed"); return this.proof(c, "register", P.registrationHash(body)); },
      presence: report => this.proof(c, "presence", require("../core/lib/koin-network/presence").presenceHash(c.config.owner, c.config.schedulerUrl, report)),
      assign: job => {
        this.assert(c);
        const checked = job?.type === "koin-provider-qualification" ? require("../core/lib/koin-network/qualification-protocol").validate(job, this.core.models.catalog, c.target, this.clock())
          : require("../core/lib/koin-network/funded-protocol").validateJob(job, this.core.models.catalog, this.clock());
        if (JSON.stringify(checked.target) !== JSON.stringify(c.target)) throw Error("The job is for another provider deployment");
        assigned = structuredClone(job);
      },
      qualification: (job, outputHash) => { matches(job); return this.proof(c, "qualification", require("../core/lib/koin-network/qualification-protocol").resultHash(job, outputHash)); },
      chunk: (job, output, sequence) => { matches(job); return this.proof(c, "chunk", require("../core/lib/koin-network/funded-protocol").fundedChunkHash(c.target, job, output, sequence)); },
      result: (job, output) => { matches(job); return this.proof(c, "result", require("../core/lib/koin-network/funded-protocol").fundedResultHash(c.target, job, output)); },
      release: () => { assigned = null; }
    });
  }
  describe() {
    let c, record; try { c = this.identity(); record = this.read(c); } catch (e) { return { state: e.code || "unavailable", detail: e.message, canAuthorize: e.code !== "wallet-required", walletLocked: !this.core.account.wallet?.status?.().unlocked, walletReady: !!this.core.account.wallet?.address, secureStorage: storageState(this.storage) }; }
    return { deviceAuthorized: !!record?.enrolled && !record.revoked && record.authorization.expiresAt > this.clock(), sessionOnly: record?.sessionOnly === true,
      expiresAt: record?.authorization.expiresAt || null, walletReady: true, secureStorage: storageState(this.storage), walletLocked: !this.core.account.wallet.status().unlocked, canAuthorize: true,
      protectedStorage: isProtectedStorage(this.storage) };
  }
  cancelPending() { if (this.busy) this.generation++; }
  dispose() {
    this.generation++;
    for (const record of this.records.values()) record.privateKey = "";
    this.records.clear(); this.lastActionAt.clear();
  }
}
module.exports = { ProviderDevice, target };
