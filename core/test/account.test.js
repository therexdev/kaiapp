"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const { Signer } = require("koilib");

/*
 * Koinos AI account, app side (task #49): the device-link sign-in and the
 * wallet attach, driven through the REAL gateway (createCore) against a
 * fake account server that verifies the wallet-link signature exactly the
 * way the production server does — koilib address recovery over
 * sha256(`link|address|accountId|ts`) — so a broken proof fails HERE, not
 * in the field.
 */

const FAKE_BIN = path.join(__dirname, "fixtures", "fake-llama-server");
const PASSWORD = "account tests 1";

function fakeAccountServer() {
  const state = {
    approved: false,
    tokens: new Set(),
    account: { id: "acc_test", email: "owner@test.co", google: false, passkeys: [], wallets: [], grants: [], sessions: 1, createdAt: 1 },
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* fine */ }
      const bearer = String(req.headers.authorization || "").replace(/^Bearer /, "");
      const authed = state.tokens.has(bearer);

      if (req.url === "/auth/device/start" && req.method === "POST") {
        return send(200, { ok: true, userCode: "TEST-CODE", deviceSecret: "ds_secret", verifyUrl: "http://x/link", expiresInSec: 600, pollSec: 0 });
      }
      if (req.url === "/auth/device/poll" && req.method === "POST") {
        if (body.deviceSecret !== "ds_secret") return send(401, { ok: false, error: "device secret does not match" });
        if (!state.approved) return send(200, { ok: true, pending: true });
        state.tokens.add("sk_apptoken");
        return send(200, { ok: true, pending: false, token: "sk_apptoken", account: state.account });
      }
      if (req.url === "/auth/session" && req.method === "GET") {
        return authed ? send(200, { ok: true, account: state.account }) : send(401, { ok: false });
      }
      if (req.url === "/auth/logout" && req.method === "POST") {
        state.tokens.delete(bearer);
        return send(200, { ok: true });
      }
      if (req.url === "/account/wallets" && req.method === "POST") {
        if (!authed) return send(401, { ok: false, error: "sign in first" });
        // The production check, verbatim in shape: recover the signer from
        // the accountId-pinned message and demand it equal the address.
        const { address, ts, signature } = body;
        if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return send(400, { ok: false, error: "stale link signature" });
        const hash = crypto.createHash("sha256").update(`link|${address}|${state.account.id}|${ts}`).digest();
        let signer;
        try {
          signer = Signer.recoverAddress(hash, Buffer.from(String(signature), "base64"));
        } catch {
          return send(400, { ok: false, error: "bad link signature" });
        }
        if (signer !== address) return send(400, { ok: false, error: "signature does not match the wallet address" });
        state.account.wallets.push({ address, linkedAt: Date.now() });
        return send(200, { ok: true, account: state.account });
      }
      /*
       * Spend grants, verified the way production verifies them: recover the
       * signer from sha256(`spend|address|accountId|cap|expiry|ts`) and
       * demand it equal the address. The DIFFERENT VERB is the point — a
       * `link` proof recovers a different hash here and is refused, which is
       * what stops "I proved I own this wallet" from ever being replayed as
       * "you may spend from it".
       */
      if (req.url === "/account/grants" && req.method === "POST") {
        if (!authed) return send(401, { ok: false, error: "sign in first" });
        const { address, maxMicro, expiresAt, ts, signature } = body;
        if (!state.account.wallets.some((w) => w.address === address)) {
          return send(409, { ok: false, error: "link this wallet to your account first" });
        }
        if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return send(400, { ok: false, error: "stale grant signature" });
        const hash = crypto.createHash("sha256")
          .update(`spend|${address}|${state.account.id}|${maxMicro}|${expiresAt}|${ts}`).digest();
        let signer;
        try {
          signer = Signer.recoverAddress(hash, Buffer.from(String(signature), "base64"));
        } catch {
          return send(400, { ok: false, error: "bad grant signature" });
        }
        if (signer !== address) return send(400, { ok: false, error: "grant signature does not match the wallet address" });
        // One live grant per wallet, as production does.
        for (const g of state.account.grants) if (g.address === address) g.live = false;
        const grant = {
          id: "grant_test_" + state.account.grants.length,
          address,
          maxUsd: maxMicro / 1e6,
          spentUsd: 0,
          remainingUsd: maxMicro / 1e6,
          createdAt: Date.now(),
          expiresAt: Number(expiresAt),
          revokedAt: null,
          live: true,
        };
        state.account.grants.push(grant);
        return send(200, { ok: true, grant, account: state.account });
      }
      const revoke = req.url.match(/^\/account\/grants\/(.+)$/);
      if (revoke && req.method === "DELETE") {
        if (!authed) return send(401, { ok: false, error: "sign in first" });
        const g = state.account.grants.find((x) => x.id === decodeURIComponent(revoke[1]) && x.live);
        if (!g) return send(404, { ok: false, error: "no live grant with that id" });
        g.live = false;
        g.revokedAt = Date.now();
        return send(200, { ok: true, account: state.account });
      }
      const unlink = req.url.match(/^\/account\/wallets\/(.+)$/);
      if (unlink && req.method === "DELETE") {
        if (!authed) return send(401, { ok: false, error: "sign in first" });
        state.account.wallets = state.account.wallets.filter((w) => w.address !== decodeURIComponent(unlink[1]));
        return send(200, { ok: true, account: state.account });
      }
      send(404, { ok: false, error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function coreWithAccount() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-account-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const base = `http://127.0.0.1:${await core.start()}`;
  const fake = await fakeAccountServer();
  const post = (p, body) =>
    fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  // Wallet + point the app at the fake network + allow egress.
  await post("/core/earn/wallet", { password: PASSWORD });
  await post("/core/network/config", { privacyMode: "network" });
  await post("/core/earn/config", { schedulerUrl: `${fake.origin}/scheduler` });
  return { core, base, fake, post, get, dir };
}

test("account: Local-Only refuses the whole surface, in words", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-account-lo-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const base = `http://127.0.0.1:${await core.start()}`;
  try {
    const r = await fetch(`${base}/core/account`);
    assert.strictEqual(r.status, 403);
    const j = await r.json();
    assert.strictEqual(j.localOnly, true, "the refusal names the privacy mode, not a mystery error");
  } finally {
    await core.stop();
  }
});

test("account: device link end-to-end — code, pending, approval, session, wallet attach, unlink, sign-out", { timeout: 60000 }, async () => {
  const { core, fake, post, get, dir } = await coreWithAccount();
  try {
    // Signed out, with the derived site shown for the UI's link.
    let s = await get("/core/account");
    assert.strictEqual(s.signedIn, false);
    assert.strictEqual(s.site, fake.origin, "account server derived from the scheduler URL");

    // Start: a human code arrives.
    const start = await post("/core/account/link/start");
    assert.strictEqual(start.userCode, "TEST-CODE");

    // Poll before approval: pending, nothing stored.
    let p = await post("/core/account/link/poll");
    assert.strictEqual(p.pending, true);
    assert.ok(!fs.existsSync(path.join(dir, "account.cfg")), "no token at rest while pending");

    // The person approves in their browser; the next poll signs the app in.
    fake.state.approved = true;
    p = await post("/core/account/link/poll");
    assert.strictEqual(p.pending, false);
    assert.strictEqual(p.account.email, "owner@test.co");
    const cfg = fs.statSync(path.join(dir, "account.cfg"));
    assert.strictEqual(cfg.mode & 0o777, 0o600, "token file is private");

    // Status is now a live session, and this wallet is not linked yet.
    s = await get("/core/account");
    assert.strictEqual(s.signedIn, true);
    assert.strictEqual(s.thisWalletLinked, false);

    // Wallet attach: the fake server RECOVERS the address from the proof.
    const link = await post("/core/account/wallet");
    assert.strictEqual(link.ok, true);
    s = await get("/core/account");
    assert.strictEqual(s.thisWalletLinked, true, "the signed proof named this wallet");
    assert.strictEqual(s.account.wallets.length, 1);

    // Unlink, then sign out; a revoked token means honestly signed out.
    const un = await post("/core/account/wallet/unlink", { address: s.account.wallets[0].address });
    assert.strictEqual(un.account.wallets.length, 0);
    await post("/core/account/logout");
    s = await get("/core/account");
    assert.strictEqual(s.signedIn, false);
    assert.ok(!fs.existsSync(path.join(dir, "account.cfg")), "token gone from disk");
  } finally {
    fake.server.close();
    await core.stop();
  }
});

test("account: a token the server no longer honors is cleared, not ghosted", { timeout: 30000 }, async () => {
  const { core, fake, post, get, dir } = await coreWithAccount();
  try {
    fake.state.approved = true;
    await post("/core/account/link/start");
    await post("/core/account/link/poll");
    assert.strictEqual((await get("/core/account")).signedIn, true);
    // Server-side revocation (signed out from the web, session expired…).
    fake.state.tokens.clear();
    const s = await get("/core/account");
    assert.strictEqual(s.signedIn, false);
    assert.ok(!fs.existsSync(path.join(dir, "account.cfg")), "stale token deleted on discovery");
  } finally {
    fake.server.close();
    await core.stop();
  }
});

/*
 * Spend grants, app side.
 *
 * This is the ONLY place a grant can be created: the signature has to come
 * from the wallet's own key, and no browser has one. So the test that matters
 * is that the app produces a proof the server can actually verify — the same
 * class of bug that once double-encoded a link signature, and would be
 * invisible until someone tried to use the website.
 */
test("account: a spending grant is signed here, verifiable there, and revocable", { timeout: 60000 }, async () => {
  const { core, fake, post, get } = await coreWithAccount();
  try {
    fake.state.approved = true;
    await post("/core/account/link/start");
    await post("/core/account/link/poll");

    // Granting spend from a wallet the account has never proven it owns
    // would be authorising a stranger. The server says so.
    const early = await post("/core/account/grant", { maxUsd: 10, days: 30 });
    assert.strictEqual(early.ok, false, "no grant before the wallet is linked");
    assert.match(String(early.error), /link this wallet/i);

    await post("/core/account/wallet");
    let s = await get("/core/account");
    assert.strictEqual(s.thisWalletLinked, true);
    assert.strictEqual(s.thisWalletGrant, null, "nothing authorised until someone asks for it");

    // The real thing: the fake server RECOVERS the address from the proof.
    const g = await post("/core/account/grant", { maxUsd: 10, days: 30 });
    assert.strictEqual(g.ok, true, `grant refused: ${g.error}`);
    assert.strictEqual(g.grant.maxUsd, 10);
    assert.ok(g.grant.expiresAt > Date.now() + 29 * 86400000, "the expiry is the window asked for");

    // Status resolves THIS machine's grant, so the UI never has to guess.
    s = await get("/core/account");
    assert.ok(s.thisWalletGrant, "status names the live grant for this wallet");
    assert.strictEqual(s.thisWalletGrant.address, s.account.wallets[0].address);
    assert.strictEqual(s.thisWalletGrant.id, g.grant.id);

    // A cap of zero is not a grant, it is a mistake — caught before signing.
    const zero = await post("/core/account/grant", { maxUsd: 0, days: 30 });
    assert.strictEqual(zero.ok, false);
    assert.match(String(zero.error), /cap above zero/i);

    // A second grant REPLACES the first: "how much may this site spend?"
    // must always have exactly one answer.
    const g2 = await post("/core/account/grant", { maxUsd: 25, days: 7 });
    assert.strictEqual(g2.ok, true);
    s = await get("/core/account");
    assert.strictEqual(s.thisWalletGrant.id, g2.grant.id);
    assert.strictEqual(s.account.grants.filter((x) => x.live).length, 1, "never two live caps on one wallet");

    // Revoking needs no key, only the session — and it is immediate.
    const rev = await post("/core/account/grant/revoke", { id: g2.grant.id });
    assert.strictEqual(rev.ok, true);
    s = await get("/core/account");
    assert.strictEqual(s.thisWalletGrant, null, "web access is off again");
  } finally {
    fake.server.close();
    await core.stop();
  }
});

test("account: unlinking the wallet leaves no live grant behind it", { timeout: 60000 }, async () => {
  const { core, fake, post, get } = await coreWithAccount();
  try {
    fake.state.approved = true;
    await post("/core/account/link/start");
    await post("/core/account/link/poll");
    await post("/core/account/wallet");
    await post("/core/account/grant", { maxUsd: 5, days: 7 });

    let s = await get("/core/account");
    const addr = s.account.wallets[0].address;
    await post("/core/account/wallet/unlink", { address: addr });
    s = await get("/core/account");
    /*
     * The production server revokes grants inside unlinkWallet; the fake one
     * here deliberately does NOT, leaving a live-looking grant row behind on
     * purpose. That makes this a test of the APP's own resolution rather than
     * the server's cleanup: with the wallet unlinked, this machine must not
     * offer to manage web access it can no longer prove it owns.
     */
    assert.strictEqual(s.thisWalletLinked, false);
    assert.strictEqual(s.thisWalletGrant, null, "an unlinked wallet reports no grant on this machine");
  } finally {
    fake.server.close();
    await core.stop();
  }
});
