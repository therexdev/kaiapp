"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { Signer } = require("koilib"), { ProviderDevice, target } = require("../../electron/provider-device");
const P = require("../lib/koin-network/provider-device-protocol"), J = require("../lib/koin-network/job-protocol");
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-device-")); t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const signer = Signer.fromSeed("wallet-first-device-fixture"), serviceConfig = structuredClone(require("../lib/koin-network/credit-service.json"));
  serviceConfig.config.schedulerUrl = "https://provider.invalid/scheduler";
  const state = { unlocked: true, protected: true, backend: "gnome_libsecret", approval: 1, now: Date.now(), signed: 0, reviews: 0, challenges: 0, enrollmentIds: [], revoked: false, loseEnroll: false, traffic: [] };
  const encryptionKey = crypto.randomBytes(32);
  const storage = { isEncryptionAvailable: () => state.protected, getSelectedStorageBackend: () => state.backend,
    encryptString: text => { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv); return Buffer.concat([iv, cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]); },
    decryptString: bytes => { const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"); } };
  const core = { account: { safeStorage: storage, wallet: { address: signer.address, status: () => ({ unlocked: state.unlocked }), signHash: async hash => { assert.equal(state.unlocked, true); state.signed++; return Buffer.from(await signer.signHash(hash)).toString("base64"); } } },
    gateway: { network: { status: () => ({ privacyMode: state.localOnly ? "local-only" : "network" }) } }, models: { catalog: { aliases: {}, packages: {} } } };
  const approved = new Map(), service = { service: serviceConfig, dataDir, fetchImpl: async (url, init) => {
    const action = url.split("/").at(-1), body = init.body ? JSON.parse(init.body) : null; state.traffic.push(action);
    if (action === "capabilities") return Response.json({ ok: true, capabilities: { walletFirstEarning: 1, delegatedProvider: 1 }, schedulerUrl: serviceConfig.config.schedulerUrl, target: target(serviceConfig.config) });
    if (action === "challenge") {
      state.challenges++;
      return Response.json({ authorization: { schema: 1, purpose: "provider", schedulerUrl: serviceConfig.config.schedulerUrl, target: target(serviceConfig.config),
        wallet: body.wallet, deviceId: body.deviceId, publicKey: body.publicKey, challenge: J.hash("challenge:" + state.challenges), issuedAt: state.now,
        challengeExpiresAt: state.now + 300000, expiresAt: state.now + 2592000000, actions: [...P.ACTIONS] } });
    }
    if (action === "enroll") {
      if (state.failBeforeEnroll) { state.failBeforeEnroll = false; throw Error("Enrollment never reached server"); }
      if (state.expireChallenge) { state.expireChallenge = false; return Response.json({ ok: false, code: "PROVIDER_CHALLENGE_EXPIRED" }, { status: 409 }); }
      const a = P.verifyWalletAuthorization(body.authorization, body.walletSignature), id = P.authorizationId(a);
      const proof = "pd1." + Buffer.from(JSON.stringify(body)).toString("base64url");
      P.verifyAction(proof, "register", P.authorizationHash(a), { now: state.now });
      approved.set(id, a); state.enrollmentIds.push(id); state.revoked = false;
      if (state.loseEnroll) { state.loseEnroll = false; throw Error("Lost enrollment response"); }
      return Response.json({ ok: true, authorizationId: id, deviceId: a.deviceId, wallet: a.wallet });
    }
    if (["status", "revoke"].includes(action)) {
      const a = P.decodeAction(body.signature).authorization, id = P.authorizationId(a);
      P.verifyAction(body.signature, action, P.hash(action + ":" + id), { now: state.now });
      if (state.revoked || !approved.has(id)) return Response.json({ ok: false, code: "PROVIDER_AUTHORIZATION_REQUIRED", error: "revoked" }, { status: 401 });
      if (action === "revoke") state.revoked = true;
      return Response.json({ ok: true, mode: "mainnet-pilot", mainnetPaymentsEnabled: true, providers: [], payouts: [] });
    }
    throw Error("Unexpected fixture route: " + action);
  } };
  const args = { service, core, clock: () => state.now, dialog: { showMessageBox: async (...args) => { state.reviews++; state.review = args.at(-1); return { response: state.approval }; } } };
  const device = new ProviderDevice(args); t.after(() => device.dispose());
  return { state, core, service, args, device, approved, signer, dataDir };
}
test("wallet-only enrollment requires native consent and signs a nonspending device authority once", async t => {
  const f = fixture(t), signal = AbortSignal.timeout(5000);
  await assert.rejects(f.device.context(signal), e => e.code === "authorization-required");
  assert.equal(f.state.signed, 0); assert.equal(f.state.challenges, 0); assert.equal(f.state.reviews, 0);
  f.state.approval = 0;
  assert.deepEqual(await f.device.authorize(null, {}, signal), { state: "cancelled" });
  assert.equal(f.state.signed, 0); assert.equal(f.approved.size, 0); assert.equal(fs.existsSync(path.join(f.dataDir, "provider-devices-v1")), false);
  f.state.approval = 1;
  const result = await f.device.authorize(null, {}, signal); assert.equal(result.state, "authorized"); assert.equal(f.state.signed, 1);
  assert.match(f.state.review.detail, /cannot spend KOIN/); assert.match(f.state.review.detail, /protected credential/);
  const c = await f.device.context(signal), bytes = fs.readFileSync(path.join(c.directory, "authorization.enc"));
  assert.equal(bytes.includes(Buffer.from(c.record.privateKey)), false); assert.equal(bytes.includes(Buffer.from(f.signer.getPrivateKey())), false);
  assert.equal(c.signer.signHash, undefined); assert.equal(c.signer.signTransaction, undefined); assert.equal(c.signer.privateKey, undefined);
  assert.throws(() => c.signer.result({ id: J.hash("unassigned") }, "answer"), /currently assigned/);
});
test("wallet lock and restart keep scoped availability signing without retaining or invoking the wallet signer", async t => {
  const f = fixture(t), signal = AbortSignal.timeout(5000); await f.device.authorize(null, {}, signal);
  const c = await f.device.context(signal); f.state.unlocked = false;
  const report = { schema: 1, session: "a".repeat(32), sequence: 1, at: f.state.now, model: "", modelHash: "", ready: false };
  const signature = c.signer.presence(report), digest = require("../lib/koin-network/presence").presenceHash(c.config.owner, c.config.schedulerUrl, report);
  assert.equal(P.verifyAction(signature, "presence", digest, { now: f.state.now }).wallet, f.signer.address);
  assert.equal(f.state.signed, 1); f.device.dispose();
  const restarted = new ProviderDevice(f.args); t.after(() => restarted.dispose());
  const resumed = await restarted.context(signal); assert.equal(restarted.describe().walletLocked, true); assert.equal(restarted.describe().deviceAuthorized, true);
  P.verifyAction(resumed.signer.presence({ ...report, sequence: 2 }), "presence", require("../lib/koin-network/presence").presenceHash(resumed.config.owner, resumed.config.schedulerUrl, { ...report, sequence: 2 }), { now: f.state.now });
  assert.equal(f.state.signed, 1);
  f.core.account.wallet.address = Signer.fromSeed("another-reward-wallet").address;
  assert.throws(() => resumed.signer.presence(report), /reward wallet|authorization changed/i);
});
test("Linux basic_text requires explicit session-only authorization and never writes a device private key", async t => {
  const f = fixture(t), signal = AbortSignal.timeout(5000); f.state.backend = "basic_text";
  await assert.rejects(f.device.authorize(null, {}, signal), e => e.code === "secure-storage-required"); assert.equal(f.state.reviews, 0); assert.equal(f.state.signed, 0);
  const result = await f.device.authorize(null, { sessionOnly: true }, signal); assert.equal(result.sessionOnly, true); assert.match(f.state.review.detail, /Session only/);
  const c = await f.device.context(signal); assert.equal(fs.existsSync(path.join(c.directory, "authorization.enc")), false);
  f.state.unlocked = false; await f.device.status(c, signal);
  const restarted = new ProviderDevice(f.args); t.after(() => restarted.dispose());
  await assert.rejects(restarted.context(signal), e => e.code === "authorization-required");
});
test("a lost enrollment response resumes the exact saved key and certificate after restart without another wallet signature", async t => {
  const f = fixture(t), signal = AbortSignal.timeout(5000); f.state.loseEnroll = true;
  await assert.rejects(f.device.authorize(null, {}, signal), /Lost enrollment/);
  assert.equal(f.state.signed, 1); assert.equal(f.state.challenges, 1); assert.equal(f.approved.size, 1);
  f.device.dispose(); f.state.unlocked = false;
  const restarted = new ProviderDevice(f.args); t.after(() => restarted.dispose());
  const result = await restarted.authorize(null, {}, signal); assert.equal(result.state, "authorized");
  assert.equal(f.state.signed, 1); assert.equal(f.state.challenges, 1); assert.equal(f.state.reviews, 1); assert.equal(f.approved.size, 1);
  assert.equal(f.state.enrollmentIds.length, 2); assert.equal(f.state.enrollmentIds[0], f.state.enrollmentIds[1]);
});
test("expiry, revocation, Local-Only and loss of protected storage block signing with specific recovery states", async t => {
  const f = fixture(t), signal = AbortSignal.timeout(5000); await f.device.authorize(null, {}, signal); const c = await f.device.context(signal);
  f.state.localOnly = true; assert.throws(() => f.device.assert(c), e => e.code === "network-required"); f.state.localOnly = false;
  f.state.protected = false; assert.throws(() => f.device.assert(c), e => e.code === "secure-storage-required"); f.state.protected = true;
  f.state.now = c.record.authorization.expiresAt; assert.throws(() => f.device.assert(c), e => e.code === "authorization-expired"); f.state.now--;
  f.state.revoked = true; await assert.rejects(f.device.status(c, signal), e => e.code === "authorization-revoked");
  assert.equal(f.device.describe().deviceAuthorized, false); assert.throws(() => f.device.assert(c), e => e.code === "authorization-revoked");
  f.state.now = Date.now(); await f.device.authorize(null, {}, signal);
  assert.equal(f.state.signed, 2); assert.equal(f.state.challenges, 2); assert.equal(f.device.describe().deviceAuthorized, true);
  assert.equal((await f.device.context(signal)).record.authorization.deviceId, c.record.authorization.deviceId, "reauthorization keeps the same physical device identity");
  assert.ok(fs.readdirSync(c.directory).some(name => name.startsWith("authorization.enc.retired-")));
});
test("device proof binds wallet, deployment, action, full registration and lifetime while archived receipts remain verifiable", async t => {
  const f = fixture(t), signal = AbortSignal.timeout(5000); await f.device.authorize(null, {}, signal); const c = await f.device.context(signal);
  const b = { address: c.config.owner, ts: f.state.now, fingerprint: "a".repeat(16), models: ["koinos-smart"], capabilities: { ramGb: 32, koinMainnetPilotJobs: 1 } };
  const proof = c.signer.register(b), digest = P.registrationHash(b);
  assert.equal(P.verifyAction(proof, "register", digest, { now: f.state.now }).deviceId, c.signer.deviceId);
  assert.equal(P.registrationHash({ ...b, capabilities: { koinMainnetPilotJobs: 1, ramGb: 32 } }).toString("hex"), digest.toString("hex"));
  for (const action of ["presence", "result", "chunk", "revoke", "status", "transfer", "purchase", "grant", "signHash"])
    assert.throws(() => P.verifyAction(proof, action, digest, { now: f.state.now }), /signature mismatch|outside/);
  assert.throws(() => P.verifyAction(proof, "register", P.registrationHash({ ...b, models: ["changed"] }), { now: f.state.now }), /signature mismatch/);
  assert.throws(() => P.verifyAction(proof, "register", digest, { wallet: Signer.fromSeed("wrong").address, now: f.state.now }), /wallet changed/);
  assert.throws(() => P.verifyAction(proof, "register", digest, { schedulerUrl: "https://wrong.invalid/scheduler", now: f.state.now }), /deployment/);
  assert.throws(() => P.verifyAction(proof, "register", digest, { now: f.state.now + 60001 }), /expired/);
  assert.doesNotThrow(() => P.verifyAction(proof, "register", digest, { now: c.record.authorization.expiresAt + 100, historical: true, completedAt: f.state.now }));
  assert.throws(() => P.verifyAction(proof, "register", digest, { now: c.record.authorization.expiresAt + 100, historical: true, completedAt: f.state.now + 60001 }), /receipt time/);
  const decoded = P.decodeAction(proof); decoded.authorization.expiresAt += 1;
  assert.throws(() => P.verifyAction("pd1." + Buffer.from(JSON.stringify(decoded)).toString("base64url"), "register", digest, { now: f.state.now }), /lifetime/);
});
test("wallet-first enrollment preserves the last model subset and Off preference without touching account balances or payment journals", async t => {
  const f = fixture(t), c = f.device.identity(), directory = path.join(f.dataDir, "credit-account-v2", "a".repeat(64), "b".repeat(64));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "context.json"), JSON.stringify({ config: c.config, accountId: "existing-account" }));
  const preference = { schema: 1, enabled: false, model: "koinos-smart", selection: { mode: "selected", models: ["koinos-smart"] } };
  fs.writeFileSync(path.join(directory, "provider-preference.json"), JSON.stringify(preference));
  const journal = Buffer.from("existing payment recovery record"); fs.writeFileSync(path.join(directory, "purchase.json"), journal);
  await f.device.authorize(null, {}, AbortSignal.timeout(5000));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.directory, "provider-preference.json"))), preference);
  assert.deepEqual(fs.readFileSync(path.join(directory, "purchase.json")), journal);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "provider-preference.json"))), preference);
});
test("Stop while the native authorization review is open cannot enable or enroll a late approval", async t => {
  const f = fixture(t); let ready, answer;
  const entered = new Promise(resolve => { ready = resolve; });
  f.device.dialog = { showMessageBox: async () => { ready(); return new Promise(resolve => { answer = resolve; }); } };
  const pending = f.device.authorize(null, {}, AbortSignal.timeout(5000)), rejected = assert.rejects(pending, /cancelled/);
  await entered; f.device.cancelPending(); answer({ response: 1 }); await rejected;
  assert.equal(f.state.signed, 0); assert.equal(f.approved.size, 0);
});
test("explicit session-only reauthorization works with an unavailable keyring while preserving the old encrypted record", async t => {
  const f = fixture(t), signal = AbortSignal.timeout(5000); await f.device.authorize(null, {}, signal);
  const c = await f.device.context(signal), file = path.join(c.directory, "authorization.enc"), encrypted = fs.readFileSync(file);
  f.device.dispose(); f.state.backend = "basic_text";
  const temporary = new ProviderDevice(f.args); t.after(() => temporary.dispose());
  await assert.rejects(temporary.authorize(null, {}, signal), e => e.code === "secure-storage-required");
  const result = await temporary.authorize(null, { sessionOnly: true }, signal); assert.equal(result.sessionOnly, true);
  const session = await temporary.context(signal);
  assert.equal(session.record.authorization.deviceId, c.record.authorization.deviceId);
  assert.notEqual(P.authorizationId(session.record.authorization), P.authorizationId(c.record.authorization));
  assert.deepEqual(fs.readFileSync(file), encrypted); f.state.unlocked = false;
  await temporary.status(session, signal); assert.equal(f.state.signed, 2);
});
test("a definitively expired unconsumed challenge offers one new review instead of retrying the old pending enrollment forever", async t => {
  const f = fixture(t), signal = AbortSignal.timeout(5000); f.state.failBeforeEnroll = true;
  await assert.rejects(f.device.authorize(null, {}, signal), /never reached/);
  const old = f.device.read(f.device.identity()); assert.equal(f.approved.size, 0);
  f.state.expireChallenge = true;
  const result = await f.device.authorize(null, {}, signal); assert.equal(result.state, "authorized");
  assert.equal(f.state.reviews, 2); assert.equal(f.state.signed, 2); assert.equal(f.approved.size, 1);
  const current = await f.device.context(signal);
  assert.equal(current.record.authorization.deviceId, old.authorization.deviceId);
  assert.notEqual(P.authorizationId(current.record.authorization), P.authorizationId(old.authorization));
});
test("background provider polling cannot cancel a native enrollment review", async t => {
  const f = fixture(t), { CreditProvider } = require("../../electron/credit-provider");
  let ready, answer; const entered = new Promise(resolve => { ready = resolve; });
  f.device.dialog = { showMessageBox: async () => { ready(); return new Promise(resolve => { answer = resolve; }); } };
  const provider = new CreditProvider({ service: f.service, core: f.core, device: f.device }); t.after(() => provider.dispose());
  const pending = provider.authorize(null, {}, AbortSignal.timeout(5000)); await entered;
  await provider.tick(); assert.equal(f.state.signed, 0); assert.equal(f.device.generation, 0);
  answer({ response: 1 }); assert.equal((await pending).state, "authorized"); assert.equal(f.approved.size, 1);
});
test("older backend and temporary proxy outage stay distinct and never enroll or fall back to wallet signing", async t => {
  const f = fixture(t), signal = AbortSignal.timeout(5000);
  f.service.fetchImpl = async () => new Response("Not found", { status: 404 });
  await assert.rejects(f.device.context(signal), e => e.code === "backend-upgrade-required");
  f.service.fetchImpl = async () => new Response("<html>Bad gateway</html>", { status: 502 });
  await assert.rejects(f.device.authorize(null, {}, signal), e => e.code === "network-unavailable");
  assert.equal(f.state.signed, 0); assert.equal(f.state.reviews, 0); assert.equal(f.approved.size, 0);
});
