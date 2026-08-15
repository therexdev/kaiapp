"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const { Scheduler } = require("../../server/scheduler");
const { createCore } = require("../server");

// The catalog's pinned identity for dev-tiny's package (§27).
const DEV_TINY_SHA = "5a1395716f7913741cc51d98581b9b1228d80987a9f7d3664106742eb06bba83";

/*
 * §32 kill switch. The operator revokes a model package by its pinned
 * sha256; the scheduler serves the list publicly at /policy; every node
 * quarantines matching local packages — chat included, earning included —
 * and the quarantine persists locally. §7 turns a quarantined local model
 * into a capability miss, so Local-First machines fail over to the network
 * instead of going dark.
 */

test("scheduler: revoke -> /policy -> unrevoke, operator-gated and restart-proof", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-kill-"));
  const sched = new Scheduler({ dataDir: dir, epoch: 60, operatorSecret: "s3cret", onEvent: () => {} });
  const port = await sched.listen();
  const base = `http://127.0.0.1:${port}`;
  try {
    const bad = await fetch(`${base}/operator/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha256: DEV_TINY_SHA }),
    });
    assert.strictEqual(bad.status, 401, "no secret, no kill switch");

    const ok = await fetch(`${base}/operator/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operator-secret": "s3cret" },
      body: JSON.stringify({ sha256: DEV_TINY_SHA.toUpperCase(), reason: "compromised weights" }),
    });
    assert.strictEqual(ok.status, 200);

    const policy = await (await fetch(`${base}/policy`)).json();
    assert.strictEqual(policy.revoked.length, 1);
    assert.strictEqual(policy.revoked[0].sha256, DEV_TINY_SHA, "stored lowercase, matched case-insensitively");
    assert.strictEqual(policy.revoked[0].reason, "compromised weights");

    // A restart must not resurrect a compromised package.
    const again = new Scheduler({ dataDir: dir, epoch: 61, onEvent: () => {} });
    assert.ok(again.revoked[DEV_TINY_SHA], "revocation list survives restarts");

    await fetch(`${base}/operator/unrevoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operator-secret": "s3cret" },
      body: JSON.stringify({ sha256: DEV_TINY_SHA }),
    });
    const cleared = await (await fetch(`${base}/policy`)).json();
    assert.strictEqual(cleared.revoked.length, 0);
  } finally {
    await sched.close();
  }
});

test("core: revoked package quarantines on policy sync; local-only refuses, local-first fails over", async () => {
  // Spy scheduler: serves the revocation on /policy and answers consume —
  // the same endpoint set a real node sees.
  const paths = [];
  const spy = http.createServer((req, res) => {
    paths.push(req.url);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.startsWith("/policy")) {
        return res.end(JSON.stringify({ ok: true, revoked: [{ sha256: DEV_TINY_SHA, reason: "compromised weights" }] }));
      }
      if (req.url.startsWith("/consume/")) {
        return res.end(JSON.stringify({
          object: "chat.completion",
          model: "koinos-network",
          choices: [{ index: 0, message: { role: "assistant", content: "served by the network" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        }));
      }
      res.end("{}");
    });
  });
  const spyPort = await new Promise((r) => spy.listen(0, "127.0.0.1", function () { r(this.address().port); }));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-kill-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const events = [];
  const core = await createCore({
    dataDir: dir, port: 0,
    llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
    onEvent: (e) => events.push(e),
  });
  const base = `http://127.0.0.1:${await core.start()}`;
  const post = async (p, b) => {
    const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    await post("/core/earn/wallet", { password: "correct horse" });
    // Local-Only machines emit nothing, not even safety polls — the sync
    // runs only in network-participating modes, so allow one first.
    await post("/core/network/config", { privacyMode: "local-first" });
    // Setting the scheduler URL triggers a prompt policy sync (§32).
    await post("/core/earn/config", { schedulerUrl: `http://127.0.0.1:${spyPort}` });

    // Wait for the quarantine to land (sync is fire-and-forget).
    for (let i = 0; i < 50 && !events.some((e) => e.type === "core:kill-switch"); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(events.some((e) => e.type === "core:kill-switch"), "policy sync quarantined the package");

    const health = await (await fetch(`${base}/core/models`)).json();
    const devTiny = health.aliases.find((a) => a.alias === "dev-tiny");
    assert.strictEqual(devTiny.status, "quarantined");
    assert.match(devTiny.quarantineReason, /compromised/);

    // Local-Only: the quarantined model refuses cleanly, nothing overflows.
    await post("/core/network/config", { privacyMode: "local-only" });
    const refused = await post("/v1/chat/completions", { model: "dev-tiny", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(refused.status, 400);
    assert.match(refused.json.error.message, /quarantined/);
    assert.strictEqual(paths.filter((p) => p.startsWith("/consume/")).length, 0);

    // Local-First: §7 treats the quarantine as a capability miss -> the
    // machine keeps answering, via the network, with the route disclosed.
    await post("/core/network/config", { privacyMode: "local-first" });
    const served = await post("/v1/chat/completions", { model: "dev-tiny", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(served.status, 200);
    assert.strictEqual(served.json.model, "koinos-network");
    assert.strictEqual(served.json.choices[0].message.content, "served by the network");
    assert.strictEqual(paths.filter((p) => p.startsWith("/consume/")).length, 1);

    // The quarantine survives a core restart (state store, not memory).
    await core.stop();
    const core2 = await createCore({
      dataDir: dir, port: 0,
      llamaBin: path.join(__dirname, "fixtures", "fake-llama-server"),
      onEvent: () => {},
    });
    const base2 = `http://127.0.0.1:${await core2.start()}`;
    const health2 = await (await fetch(`${base2}/core/models`)).json();
    assert.strictEqual(health2.aliases.find((a) => a.alias === "dev-tiny").status, "quarantined");
    await core2.stop();
  } finally {
    await core.stop().catch(() => {});
    spy.close();
  }
});
