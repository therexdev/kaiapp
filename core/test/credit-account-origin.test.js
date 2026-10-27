"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { AccountService } = require("../lib/account");
const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
const creditOrigin = "https://credits.koinosai.com";

test("pinned credit sessions survive restart separately from website credentials and settings", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-credit-origin-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let scheduler = "https://website.invalid/scheduler";
  const settings = { get: key => key === "network.privacyMode" ? "local-first" : scheduler };
  const options = { dataDir, settings, safeStorage: storage };
  const website = new AccountService(options), credits = new AccountService({ ...options, accountOrigin: creditOrigin });
  website._saveToken("website-session"); const old = fs.readFileSync(website.file);
  assert.equal(credits._token(), null);
  credits._saveToken("credit-session");
  assert.equal(new AccountService({ ...options, accountOrigin: creditOrigin })._token(), "credit-session");
  assert.equal(new AccountService({ ...options, accountOrigin: "https://another.invalid" })._token(), null);
  scheduler = "https://changed-website.invalid/scheduler";
  assert.equal(credits.origin(), creditOrigin); assert.equal(website.origin(), "https://changed-website.invalid");
  const requests = [];
  t.mock.method(global, "fetch", async (url, init) => {
    requests.push(url); assert.equal(new URL(url).origin, creditOrigin);
    assert.equal(init.headers.authorization, "Bearer credit-session"); assert.equal(init.redirect, "error"); assert.ok(init.signal);
    return Response.json({ ok: true, account: { id: "credit-user", wallets: [] } });
  });
  const auth = await credits.creditAuthorization(creditOrigin + "/scheduler");
  assert.equal(auth.accountId, "credit-user");
  await assert.rejects(website.creditAuthorization(creditOrigin + "/scheduler"), /account service/);
  const backup = require("../lib/profile-backup").backupLiveProfile(dataDir, "credit-activation-test");
  assert.deepEqual(fs.readFileSync(path.join(backup, path.basename(credits.file))), fs.readFileSync(credits.file));
  await credits.signOut();
  assert.throws(() => credits.assertCreditAuthorization(auth, creditOrigin + "/scheduler"), /changed/);
  assert.equal(credits._token(), null); assert.deepEqual(fs.readFileSync(website.file), old);
  assert.equal(requests.length, 2);
  for (const accountOrigin of ["http://credits.invalid", "https://credits.invalid/path", "https://user:secret@credits.invalid", "https://credits.invalid/"]) {
    assert.throws(() => new AccountService({ ...options, accountOrigin }), /canonical HTTPS/);
  }
});

test("normal account routes and native credit IPC use the credit service while Connections keeps its website account", async t => {
  const { EventEmitter } = require("node:events");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-credit-gateway-"));
  const core = await require("../server").createCore({ dataDir, port: 0, creditAccountOrigin: creditOrigin, onEvent() {} });
  const base = `http://127.0.0.1:${await core.start()}`;
  let registration;
  t.after(async () => { registration?.dispose(); await core.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  core.settings.set("earn.schedulerUrl", "https://website.invalid/scheduler");
  core.account.safeStorage = core.creditAccount.safeStorage = storage;
  core.account._saveToken("website-session");
  const old = fs.readFileSync(core.account.file), realFetch = global.fetch, calls = [];
  t.mock.method(global, "fetch", async (url, init = {}) => {
    if (url.startsWith(base)) return realFetch(url, init);
    const u = new URL(url); calls.push(url);
    if (u.origin === creditOrigin) {
      assert.equal(init.redirect, "error");
      if (u.pathname === "/auth/device/start") return Response.json({ ok: true, userCode: "CREDIT-CODE", deviceSecret: "fixture", verifyUrl: creditOrigin + "/link", expiresInSec: 600 });
      if (u.pathname === "/auth/device/poll") return Response.json({ ok: true, token: "credit-session", account: { id: "credit-user", wallets: [] } });
      assert.equal(init.headers.authorization, "Bearer credit-session");
      return Response.json({ ok: true, account: { id: "credit-user", wallets: [] } });
    }
    if (u.origin === "https://website.invalid" && u.pathname === "/auth/session") {
      assert.equal(init.headers.authorization, "Bearer website-session");
      return Response.json({ ok: true, account: { id: "website-user", wallets: [] } });
    }
    throw Error("Unexpected egress: " + url);
  });
  const request = async (route, post = false) => {
    const r = await fetch(base + route, post ? { method: "POST" } : {});
    return { status: r.status, ...await r.json() };
  };
  assert.equal((await request("/core/account")).status, 403);
  assert.equal((await request("/core/website-account/link/start", true)).status, 403); assert.equal(calls.length, 0);
  core.settings.set("network.privacyMode", "local-first");
  const signedOut = await request("/core/account");
  assert.equal(signedOut.scope, "credits"); assert.equal(signedOut.site, creditOrigin); assert.equal(signedOut.signedIn, false);
  assert.equal((await request("/core/account/link/start", true)).userCode, "CREDIT-CODE");
  assert.equal((await request("/core/account/link/poll", true)).pending, false);
  assert.equal((await request("/core/account")).account.id, "credit-user");
  assert.equal((await request("/core/website-account")).account.id, "website-user");
  assert.strictEqual(core.account, core.gateway.account); assert.strictEqual(core.creditAccount, core.gateway.creditAccount);
  assert.equal((await request("/core/account/grant", true)).status, 404);
  // The packaged manifest has no fixed owner; native operations select this signed-in identity.
  const w = Object.assign(new EventEmitter(), { webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
  w.webContents.mainFrame = { url: base + "/" }; let handle;
  registration = require("../../electron/koin-test-ipc").registerTestPaymentIPC({ core, dataDir, isTest: true, dialog: {}, origin: base, getMainWindow: () => w, ipcMain: { handle: (_name, fn) => { handle = fn; } } });
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  const info = await handle(event, "purchase-info");
  assert.equal(info.activation, "ready");
  assert.equal((await request("/core/account/logout", true)).ok, true);
  assert.equal((await handle(event, "purchase-info")).activation, "wallet-connection-required");
  assert.deepEqual(fs.readFileSync(core.account.file), old);
  assert.equal(core.settings.get("earn.schedulerUrl"), "https://website.invalid/scheduler");
});
