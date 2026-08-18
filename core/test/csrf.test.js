"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { Gateway } = require("../lib/gateway");
const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");
const { ApiKeys } = require("../lib/keys");
const { ToolRegistry } = require("../lib/tools");

/*
 * The control plane must answer Koinos AI and refuse the web.
 *
 * /core/* carries no API key by design — it is the app talking to itself —
 * and request bodies are JSON.parsed without checking content-type. That was
 * exploitable: `content-type: text/plain` is CORS-safelisted, so a POST from
 * any page the user was visiting went out as a "simple request" with no
 * preflight and was parsed as JSON. The reply is unreadable to the attacker;
 * the side effect is not. /core/tools/call was the sharp end — its `confirmed`
 * flag is taken from the body, so a drive-by POST could run a sensitive tool
 * straight through the confirm-before-use gate.
 *
 * These fail on the pre-guard gateway.
 */

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-csrf-"));

async function startGateway() {
  const dir = tmp();
  const catalogPath = path.join(__dirname, "..", "models", "catalog.json");
  const tools = new ToolRegistry({ privacyMode: () => "network" });
  let ran = 0;
  tools.register({
    name: "danger",
    description: "stands in for any sensitive tool",
    egress: false,
    sensitive: true,
    handler: () => { ran += 1; return "did it"; },
  });
  const gw = new Gateway({
    host: "127.0.0.1",
    port: 0,
    models: new ModelManager({ catalogPath, modelsDir: path.join(dir, "m"), state: new JsonStore(path.join(dir, "s.json"), {}), onEvent: () => {} }),
    keys: new ApiKeys(new JsonStore(path.join(dir, "k.json"), {})),
    runtime: { status: () => ({ running: false }) },
    coreInfo: () => ({ version: "test" }),
    tools,
    onEvent: () => {},
  });
  await gw.listen();
  return { gw, base: `http://127.0.0.1:${gw.port}`, ranCount: () => ran };
}

test("control plane: a drive-by POST from another site cannot run a sensitive tool", async () => {
  const { gw, base, ranCount } = await startGateway();
  try {
    // Exactly the shape a malicious page can send with no preflight:
    // a CORS-safelisted content-type, and `confirmed` asserted in the body.
    const res = await fetch(`${base}/core/tools/call`, {
      method: "POST",
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ name: "danger", args: {}, confirmed: true }),
    });
    assert.strictEqual(res.status, 403, "refused before the handler ever sees it");
    assert.strictEqual(ranCount(), 0, "and the tool did NOT run — this is the whole point");
  } finally {
    await gw.close();
  }
});

test("control plane: a foreign Origin is refused even on a read", async () => {
  const { gw, base } = await startGateway();
  try {
    const res = await fetch(`${base}/core/health`, { headers: { origin: "https://evil.example" } });
    assert.strictEqual(res.status, 403, "reads leak state too — the watch address, settings, model list");
  } finally {
    await gw.close();
  }
});

test("control plane: the three legitimate callers still work", async () => {
  const { gw, base } = await startGateway();
  try {
    // 1. The renderer. Electron loads it FROM this server, so its Origin is ours.
    const renderer = await fetch(`${base}/core/health`, {
      headers: { origin: `http://127.0.0.1:${gw.port}`, "sec-fetch-site": "same-origin" },
    });
    assert.strictEqual(renderer.status, 200, "the app's own UI must not be locked out");

    // localhost and 127.0.0.1 are the same server and both are reachable.
    const alt = await fetch(`${base}/core/health`, { headers: { origin: `http://localhost:${gw.port}` } });
    assert.strictEqual(alt.status, 200);

    // 2. The Electron main process — Node fetch, no Origin header at all.
    const main = await fetch(`${base}/core/health`);
    assert.strictEqual(main.status, 200, "main.js polls /core/earn and /core/earn/nudge this way");

    // 3. A local script or another app on the machine.
    const script = await fetch(`${base}/core/models`, { headers: { "user-agent": "curl/8.0" } });
    assert.strictEqual(script.status, 200);
  } finally {
    await gw.close();
  }
});

test("control plane: the guard reads the header, not the attacker's promise", async () => {
  const { gw, base } = await startGateway();
  try {
    // A page cannot forge Origin — but it CAN omit Sec-Fetch-Site while
    // claiming a foreign Origin, or claim same-origin while being cross-site.
    // Either signal alone is enough to refuse.
    const noSecFetch = await fetch(`${base}/core/health`, { headers: { origin: "https://evil.example" } });
    assert.strictEqual(noSecFetch.status, 403, "a foreign Origin is refused with no Sec-Fetch-Site present");

    const lyingSite = await fetch(`${base}/core/health`, {
      headers: { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
    });
    assert.strictEqual(lyingSite.status, 403, "claiming same-origin does not excuse a foreign Origin");

    const crossSiteNoOrigin = await fetch(`${base}/core/health`, { headers: { "sec-fetch-site": "cross-site" } });
    assert.strictEqual(crossSiteNoOrigin.status, 403, "cross-site is refused even with Origin stripped");
  } finally {
    await gw.close();
  }
});

test("the OpenAI-compatible API stays open to local callers by design", async () => {
  const { gw, base } = await startGateway();
  try {
    // /v1/* exists so other programs on this machine can point at it. It is
    // guarded by an API key once one is created, not by the same-site rule —
    // locking it to the app would defeat its purpose.
    const res = await fetch(`${base}/v1/models`, { headers: { origin: "https://somewhere.example" } });
    assert.notStrictEqual(res.status, 403, "a local tool with a browser-ish Origin must still reach /v1");
  } finally {
    await gw.close();
  }
});
