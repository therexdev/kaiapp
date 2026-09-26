"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const { Signer } = require("koilib");
const { createCore } = require("../server");
const { consume, scheduler } = require("../lib/koin-network/grant-chat");
const P = require("../lib/koin-network/job-protocol");
const worker = Signer.fromSeed("grant-consumer-fixture-worker"), owner = Signer.fromSeed("grant-consumer-fixture-owner").getAddress();
const messages = [{ role: "user", content: "hello" }], requestId = P.hash("request");
const authorization = { sessionToken: "fixture-private-session", grantId: "grant_fixture", owner };
const args = { schedulerUrl: "https://scheduler.invalid/scheduler", authorization, messages, model: "auto", maxOutput: 16, requestId };

async function result(body, address = owner) {
  const tariff = { contextTokens: 4096, inputAtomsPerMillion: "1000000", maxLatencyMs: 60000,
    maxOutputTokens: 64, model: "koinos-fast", modelHash: P.hash("model"), outputAtomsPerMillion: "2000000",
    templateHash: P.hash("template"), tokenizerHash: P.hash("tokenizer"), version: 1 };
  const at = Date.now(), maxOutput = body.max_tokens || 16;
  const q = { schema: 2, mode: "shadow", domain: "shadow:grant-consumer", policyHash: P.hash("policy"), tariff,
    requestHash: P.hash(JSON.stringify(body.messages)), promptHash: P.hash("prompt"), inputIdsHash: P.hash("ids"), inputTokens: 3,
    maxOutput, maxCharge: String(3 + maxOutput * 2), at, expires: at + 300000 };
  q.hash = P.hash(JSON.stringify(q));
  const output = "4", attempt = P.hash("attempt"), id = body.requestId;
  const receipt = { mode: "shadow", domain: q.domain, job: id, quoteHash: q.hash, policyHash: q.policyHash,
    owner: address, provider: worker.getAddress(), attempt, outputHash: P.hash(output),
    signature: Buffer.from(await worker.signHash(P.resultHash(q.domain, id, attempt, q.hash, output))).toString("base64"),
    usage: { inputTokens: 3, outputTokens: 1, amount: "5" } };
  return { id, model: "koinos-network", object: "chat.completion", servedModel: tariff.model,
    choices: [{ message: { role: "assistant", content: output } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    costUsd: 0, koin: { mode: "shadow", paymentsEnabled: false, state: "verified", quote: q, receipt, receiptHash: P.hash(JSON.stringify(receipt)) } };
}

test("consumer verifies signed answer, exact intent and usage and refuses redirects", async () => {
  let sent;
  const good = await consume({ ...args, fetchImpl: async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return Response.json(await result(sent.body));
  } });
  assert.match(good.warning, /no KOIN was spent/); assert.equal(good.choices[0].message.content, "4");
  assert.equal(sent.options.redirect, "error"); assert.equal(sent.body.billing, "koin-shadow");
  assert.equal(sent.body.signature, undefined); assert.equal(sent.body.sessionToken, authorization.sessionToken);
  for (const change of [
    r => { r.id = P.hash("other"); }, r => { r.costUsd = 1; }, r => { r.koin.paymentsEnabled = true; },
    r => { r.koin.receipt.owner = worker.getAddress(); }, r => { r.koin.receipt.usage.amount = "1"; },
    r => { r.koin.receipt.signature = "bad"; }, r => { r.choices[0].message.content = "changed"; },
    r => { r.koin.quote.requestHash = P.hash("other prompt"); }, r => { r.usage.total_tokens = 999; },
    r => { r.koin.receipt.provider = owner; },
  ]) await assert.rejects(consume({ ...args, fetchImpl: async (_url, options) => {
    const r = await result(JSON.parse(options.body)); change(r);
    // A hostile endpoint can rehash a modified receipt, but cannot forge the
    // worker signature or make inconsistent price/usage commitments valid.
    r.koin.receiptHash = P.hash(JSON.stringify(r.koin.receipt)); return Response.json(r);
  } }));
  for (const url of ["http://remote.invalid", "https://user:secret@remote.invalid", "https://remote.invalid/?token=x"])
    assert.throws(() => scheduler(url));
});

async function fixture(t) {
  let core, mode = "good", began, endRemote;
  const calls = [], started = () => new Promise(resolve => { began = resolve; });
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url: req.url, authorization: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/auth/session") {
      res.end(JSON.stringify({ ok: true, account: { id: "acc_fixture", wallets: [{ address: core.account.wallet.address }],
        grants: [{ id: authorization.grantId, live: true, address: core.account.wallet.address }] } })); return;
    }
    if (req.url === "/scheduler/consume/chat/completions") {
      if (mode === "wait") { res.on("close", () => endRemote?.()); began?.(); return; }
      if (mode === "error") { res.statusCode = 403; res.end(JSON.stringify({ error: { message: "Grant revoked" } })); return; }
      res.end(JSON.stringify(await result(body, core.account.wallet.address))); return;
    }
    res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const remote = `http://127.0.0.1:${server.address().port}/scheduler`, dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-grant-consumer-"));
  const old = process.env.KAI_KOIN_SHADOW_CONSUMER_URL;
  process.env.KAI_KOIN_SHADOW_CONSUMER_URL = remote;
  try { core = await createCore({ dataDir: dir, port: 0, onEvent() {} }); }
  finally { if (old === undefined) delete process.env.KAI_KOIN_SHADOW_CONSUMER_URL; else process.env.KAI_KOIN_SHADOW_CONSUMER_URL = old; }
  core.account.wallet.create({ password: "fixture password" });
  core.account._saveToken(authorization.sessionToken);
  core.settings.set("earn.schedulerUrl", remote);
  const base = `http://127.0.0.1:${await core.start()}`;
  t.after(async () => { await core.stop(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (route, body, extra = {}) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...extra });
  const chat = (body = {}, extra) => post("/v1/chat/completions", { model: "koinos-network", messages, max_tokens: 16, ...body }, extra);
  return { core, base, remote, calls, post, chat, started, mode: v => { mode = v; }, closed: () => new Promise(r => { endRemote = r; }) };
}

test("desktop reuses account grant, displays a verified answer and never falls back to legacy billing", async t => {
  const f = await fixture(t);
  assert.equal((await f.chat()).status, 400); assert.equal(f.calls.length, 0, "Local-Only has zero scheduler egress");
  f.core.settings.set("network.privacyMode", "network");
  assert.equal((await f.chat({ koin_request_id: "invalid" })).status, 400); assert.equal(f.calls.length, 0);
  f.core.settings.set("earn.schedulerUrl", f.remote + "/other");
  assert.equal((await f.chat()).status, 502); assert.equal(f.calls.length, 0, "pin mismatch cannot send credentials");
  f.core.settings.set("earn.schedulerUrl", f.remote);
  f.core.account.wallet.signHash = () => { throw Error("No per-prompt wallet signature is allowed"); };
  const response = await f.chat({ koin_request_id: requestId }), j = await response.json();
  assert.equal(response.status, 200, JSON.stringify(j)); assert.match(j.warning, /no KOIN was spent/);
  assert.equal(j.id, requestId); assert.equal(j.choices[0].message.content, "4");
  const st = await (await fetch(f.base + "/core/network")).text();
  assert.ok(!st.includes(authorization.sessionToken)); assert.ok(!JSON.stringify(j).includes(authorization.sessionToken));
  const stream = await f.chat({ stream: true }); assert.equal(stream.status, 200);
  const text = await stream.text(); assert.match(text, /no KOIN was spent/); assert.match(text, /data: \[DONE\]/);
  f.mode("error"); const failed = await f.chat(); assert.equal(failed.status, 502); assert.match(await failed.text(), /Grant revoked/);
  assert.equal(f.calls.filter(c => c.url.endsWith("/consume/chat/completions")).length, 3);
  assert.ok(f.calls.every(c => !c.body || c.body.billing === "koin-shadow"));
});

test("Stop and switching to Local-Only abort in-flight rehearsal HTTP without fallback", async t => {
  for (const reason of ["stop", "privacy"]) {
    const f = await fixture(t); f.core.settings.set("network.privacyMode", "network"); f.mode("wait");
    const started = f.started(), closed = f.closed(), controller = new AbortController();
    const pending = f.chat({}, { signal: controller.signal }).catch(e => e);
    await started;
    if (reason === "stop") controller.abort();
    else await (await f.post("/core/network/config", { privacyMode: "local-only" })).text();
    await pending;
    await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("Remote request did not stop")), 3000); timer.unref(); })]);
    assert.equal(f.calls.filter(c => c.url.endsWith("/consume/chat/completions")).length, 1);
  }
});


test("funded chat closure shares the Local-Only and Stop boundary without billing fallback", async t => {
  for (const reason of ["stop", "privacy"]) {
    const f = await fixture(t); f.mode("wait");
    f.core.gateway.koinFundedConsume = async ({ signal }) => {
      await fetch(f.remote + "/consume/chat/completions", { method: "POST", signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ billing: "koin-funded-rehearsal" }) });
      throw Error("Unexpected completion");
    };
    assert.equal((await f.chat()).status, 400); assert.equal(f.calls.length, 0);
    f.core.settings.set("network.privacyMode", "network");
    const started = f.started(), closed = f.closed(), controller = new AbortController();
    const pending = f.chat({}, { signal: controller.signal }).catch(e => e);
    await started;
    if (reason === "stop") controller.abort();
    else await (await f.post("/core/network/config", { privacyMode: "local-only" })).text();
    await pending;
    await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("Funded request did not stop")), 3000); timer.unref(); })]);
    assert.equal(f.calls.filter(c => c.url.endsWith("/consume/chat/completions")).length, 1);
    assert.ok(f.calls.every(c => c.body?.billing === "koin-funded-rehearsal"));
  }
});
