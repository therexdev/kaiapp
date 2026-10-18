"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), { AccountService } = require("../lib/account");
test("credit authorization uses a verified session without a wallet, and revocation or privacy changes invalidate it", async t => {
  let token = "private-session", privacy = "online", reads = 0;
  const account = new AccountService({ dataDir: "/unused", settings: { get: key => key === "network.privacyMode" ? privacy : "https://credit.invalid/scheduler" } });
  account._token = () => token; account._encrypted = () => true;
  const original = global.fetch; t.after(() => { global.fetch = original; });
  global.fetch = async (url, options) => { reads++; assert.equal(url, "https://credit.invalid/auth/session"); assert.equal(options.headers.authorization, "Bearer private-session"); return Response.json({ ok: true, account: { id: "verified-user", wallets: [] } }); };
  const auth = await account.creditAuthorization("https://credit.invalid/scheduler");
  assert.match(auth.owner, /^account-[a-f0-9]{64}$/); assert.equal(reads, 1);
  account.assertCreditAuthorization(auth, auth.schedulerUrl);
  token = null; assert.throws(() => account.assertCreditAuthorization(auth, auth.schedulerUrl), /changed/);
  token = "private-session"; privacy = "local-only";
  await assert.rejects(account.creditAuthorization(auth.schedulerUrl), /online route/); assert.equal(reads, 1);
  privacy = "online"; await assert.rejects(account.creditAuthorization("https://other.invalid/scheduler"), /account service/); assert.equal(reads, 1);
  global.fetch = async () => new Response("x".repeat(65537));
  await assert.rejects(account.creditAuthorization(auth.schedulerUrl), /too large/);
});
