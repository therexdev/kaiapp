"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const { DeviceFreeAccount } = require("../lib/device-free-account"), { pin } = require("../lib/wallet-credit-account");
const P = require("../lib/koin-network/job-protocol"), { Signer } = require("koilib");
const config = { schedulerUrl: "https://credits.fixture.invalid/scheduler", policyHash: P.hash("free-fixture-policy"),
  deployment: { product: "prepaid-usd-v1", chainId: require("../lib/koin-network/payment-network").MAINNET_CHAIN,
    credits: Signer.fromSeed("device-free-public-contract-fixture").address, creditsHash: "0x1220" + P.hash("free-contract") } };
const expected = pin(config, "https://credits.fixture.invalid");
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function identityFor(publicKey) { return "guest_" + digest(JSON.stringify(["KAI-DEVICE-FREE-IDENTITY-V1", digest(JSON.stringify([expected.serviceOrigin, expected.schedulerUrl, expected.target])), publicKey])); }
function signingBytes(c) { return crypto.createHash("sha256").update(JSON.stringify(["KAI-DEVICE-FREE-SESSION-V1", c.schema, c.purpose, c.serviceOrigin, c.schedulerUrl,
  c.target.chainId, c.target.credits, c.target.creditsHash, c.target.domain, c.target.policyHash, c.publicKey, c.nonce, c.issuedAt, c.expiresAt, c.sessionExpiresAt])).digest(); }
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kai-device-free-")); let privacy = "local-first", now = Date.now(), hold;
  const calls = [], challenges = new Map(), accounts = new Map(); let transform = (_route, value) => value;
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null; calls.push({ route: req.url, body, authorization: req.headers.authorization });
    let value;
    if (req.url === "/auth/device-free/capabilities") value = { ok: true, capabilities: { deviceFreeCredits: 1, scope: "device-free", freeOnly: true,
      algorithm: "Ed25519", ...expected, challengeTtlMs: 300000, sessionTtlMs: 86400000 } };
    else if (req.url === "/auth/device-free/challenge") {
      assert.deepEqual(Object.keys(body), ["publicKey"]);
      const key = crypto.createPublicKey({ key: Buffer.from(body.publicKey, "base64"), format: "der", type: "spki" }); assert.equal(key.asymmetricKeyType, "ed25519");
      const c = { schema: 1, purpose: "device-free-session", ...expected, publicKey: body.publicKey, nonce: crypto.randomBytes(32).toString("hex"), issuedAt: now, expiresAt: now + 300000, sessionExpiresAt: now + 86400000 };
      challenges.set(c.nonce, c); value = { ok: true, challenge: c };
    } else if (req.url === "/auth/device-free/verify") {
      assert.deepEqual(Object.keys(body).sort(), ["challengeId", "signature"]);
      const c = challenges.get(body.challengeId); assert.ok(c);
      assert.equal(crypto.verify(null, signingBytes(c), crypto.createPublicKey({ key: Buffer.from(c.publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(body.signature, "base64")), true);
      const id = identityFor(c.publicKey); if (!accounts.has(id)) accounts.set(id, { created: now, available: "750000" });
      value = { ok: true, token: "df_" + crypto.randomBytes(32).toString("base64url"), scope: "device-free", freeOnly: true, expiresAt: c.sessionExpiresAt,
        account: { id, scope: "device-free", freeOnly: true, wallets: [], expiresAt: c.sessionExpiresAt } };
    } else { res.writeHead(404); res.end("{}"); return; }
    value = transform(req.url, structuredClone(value));
    if (hold) await hold(req.url);
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const settings = { get: () => privacy }, fetchImpl = (url, init) => { assert.equal(new URL(url).origin, expected.serviceOrigin); return fetch(base + new URL(url).pathname, init); };
  const clients = [], create = () => { const client = new DeviceFreeAccount({ dataDir: directory, config, settings, fetchImpl, clock: () => now }); clients.push(client); return client; };
  t.after(() => { clients.forEach(c => c.dispose()); server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, calls, accounts, create, setPrivacy: value => { privacy = value; }, advance: value => { now += value; },
    transform: fn => { transform = fn; }, hold: fn => { hold = fn; } };
}

test("automatic free access uses one signed installation identity, survives restart and never persists bearer or alters paid account", async t => {
  const f = await fixture(t), client = f.create(), paid = path.join(f.directory, "credit-account-existing.cfg"); fs.writeFileSync(paid, "existing-encrypted-paid-account");
  const auths = await Promise.all(Array.from({ length: 5 }, () => client.creditAuthorization(config.schedulerUrl)));
  assert.equal(new Set(auths.map(a => a.sessionToken)).size, 1); assert.equal(f.calls.length, 3);
  const auth = auths[0]; assert.equal(auth.scope, "device-free"); assert.equal(auth.sessionOnly, true); assert.equal(auth.freeOnly, true); assert.equal(auth.localWallet, null);
  assert.equal(auth.owner, "account-" + digest("verified-account:" + auth.accountId)); client.assertCreditAuthorization(auth, config.schedulerUrl);
  const bytes = fs.readFileSync(client.file); assert.equal(bytes.includes(auth.sessionToken), false); assert.equal(bytes.includes("wallet"), false);
  if (process.platform !== "win32") { assert.equal(fs.statSync(client.file).mode & 0o777, 0o600); assert.equal(fs.statSync(client.directory).mode & 0o777, 0o700); }
  f.accounts.get(auth.accountId).available = "250000"; client.dispose();
  const next = f.create(), resumed = await next.creditAuthorization(config.schedulerUrl);
  assert.equal(resumed.accountId, auth.accountId); assert.notEqual(resumed.sessionToken, auth.sessionToken); assert.deepEqual(fs.readFileSync(next.file), bytes);
  assert.equal(f.accounts.size, 1); assert.equal(f.accounts.get(resumed.accountId).available, "250000", "reconnection cannot replenish the established account");
  assert.equal(fs.readFileSync(paid, "utf8"), "existing-encrypted-paid-account");
  assert.deepEqual([...new Set(f.calls.map(c => c.route))], ["/auth/device-free/capabilities", "/auth/device-free/challenge", "/auth/device-free/verify"]);
  assert.equal(f.calls.some(c => c.authorization), false);
});

test("Local-Only makes no requests or installation key and fences a late connection when privacy changes", async t => {
  const f = await fixture(t), client = f.create(); f.setPrivacy("local-only");
  await assert.rejects(client.creditAuthorization(config.schedulerUrl), /Choose Network/); assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(client.directory), false);
  f.setPrivacy("local-first"); let release, entered; const reached = new Promise(resolve => { entered = resolve; });
  f.hold(route => route.endsWith("verify") ? new Promise(resolve => { release = resolve; entered(); }) : undefined);
  const pending = client.creditAuthorization(config.schedulerUrl), rejected = assert.rejects(pending, /Choose Network/);
  await reached; f.setPrivacy("local-only"); release(); await rejected; assert.equal(client.session, null);
  await assert.rejects(client.creditAuthorization(config.schedulerUrl), /Choose Network/); assert.equal(f.calls.length, 3);
});

test("free access validates service pin, challenge authority and response identity before accepting a session", async t => {
  const changes = [
    ["capabilities", value => { value.capabilities.target.policyHash = P.hash("different"); }, 1],
    ["challenge", value => { value.challenge.publicKey = "wrong"; }, 2],
    ["challenge", value => { value.challenge.expiresAt++; }, 2],
    ["challenge", value => { value.challenge.purpose = "wallet-credit-session"; }, 2],
    ["verify", value => { value.freeOnly = false; }, 3],
    ["verify", value => { value.account.id = "guest_" + P.hash("other"); }, 3],
    ["verify", value => { value.account.wallets = [{ address: config.deployment.credits }]; }, 3]
  ];
  for (const [route, change, expectedCalls] of changes) {
    await t.test(route, async t => {
      const f = await fixture(t), client = f.create(); f.transform((current, value) => { if (current.endsWith(route)) change(value); return value; });
      await assert.rejects(client.creditAuthorization(config.schedulerUrl), /network|installation|account|challenge|access/);
      assert.equal(client.session, null); assert.equal(f.calls.length, expectedCalls);
      await assert.rejects(client.creditAuthorization(config.schedulerUrl), /Retrying shortly/); assert.equal(f.calls.length, expectedCalls, "failure retry is bounded");
    });
  }
});

test("corrupt, replaced, symlinked and permissive identities are preserved and never silently regenerated", async t => {
  for (const kind of ["corrupt", "replace", ...(process.platform === "win32" ? [] : ["symlink", "permissions"])]) {
    await t.test(kind, async t => {
      const f = await fixture(t), client = f.create(), auth = await client.creditAuthorization(config.schedulerUrl), original = fs.readFileSync(client.file);
      if (kind === "corrupt") fs.writeFileSync(client.file, "preserve-this-corrupt-record");
      if (kind === "replace") { const value = JSON.parse(original), pair = crypto.generateKeyPairSync("ed25519"); value.privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"); value.publicKey = crypto.createPublicKey(pair.privateKey).export({ format: "der", type: "spki" }).toString("base64"); fs.writeFileSync(client.file, JSON.stringify(value)); }
      if (kind === "symlink") { const target = path.join(f.directory, "preserved-key.json"); fs.writeFileSync(target, original, { mode: 0o600 }); fs.unlinkSync(client.file); fs.symlinkSync(target, client.file); }
      if (kind === "permissions") fs.chmodSync(client.file, 0o644);
      const changed = fs.readFileSync(client.file);
      assert.throws(() => client.assertCreditAuthorization(auth, config.schedulerUrl), /preserved/);
      await assert.rejects(client.creditAuthorization(config.schedulerUrl), /preserved/); assert.equal(f.calls.length, 3); assert.deepEqual(fs.readFileSync(client.file), changed);
    });
  }
});

test("one cancelled reader does not cancel another, but clear aborts setup and invalidates only its own token", async t => {
  const f = await fixture(t), client = f.create(); let release, entered; const reached = new Promise(resolve => { entered = resolve; });
  f.hold(route => route.endsWith("verify") ? new Promise(resolve => { release = resolve; entered(); }) : undefined);
  const first = new AbortController(), pending = client.creditAuthorization(config.schedulerUrl, first.signal), rejected = assert.rejects(pending, /cancelled reader/);
  const other = client.creditAuthorization(config.schedulerUrl); await reached; first.abort(Error("cancelled reader")); await rejected; release();
  const auth = await other; assert.equal(f.calls.length, 3); client.assertCreditAuthorization(auth, config.schedulerUrl);
  client.invalidate({ sessionToken: "unrelated" }); client.assertCreditAuthorization(auth, config.schedulerUrl);
  client.invalidate(auth); assert.throws(() => client.assertCreditAuthorization(auth, config.schedulerUrl), /expired or changed/);
  f.hold(null); const next = await client.creditAuthorization(config.schedulerUrl); assert.equal(next.accountId, auth.accountId);
  client.clear(); let releaseAgain, enteredAgain; const reachedAgain = new Promise(resolve => { enteredAgain = resolve; });
  f.hold(route => route.endsWith("verify") ? new Promise(resolve => { releaseAgain = resolve; enteredAgain(); }) : undefined);
  const stopped = client.creditAuthorization(config.schedulerUrl), stoppedCheck = assert.rejects(stopped, /ended/);
  await reachedAgain; client.clear(); releaseAgain(); await stoppedCheck; assert.equal(client.session, null);
});
