"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { KoinosService } = require("../lib/koinos");
const { ChainRead, formatKoin } = require("../lib/chain-read");
const { JsonStore } = require("../lib/store");
const { NODE_REQUIREMENTS } = require("../lib/chain-constants");

/*
 * Koinos node tools, stage 1 — read only.
 *
 * The two properties that let this ship without a password prompt or a money
 * test: OFF is genuinely inert, and there is no code path that signs.
 */

const store = () => new JsonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kai-kn-")), "s.json"), {});
const hw = (over = {}) => ({ platform: "linux", arch: "x64", ramBytes: 32 * 1024 ** 3, diskFreeBytes: 200 * 1024 ** 3, ...over });

test("koinos: off by default, and off means INERT — not merely hidden", async () => {
  const k = new KoinosService({ settings: store(), hardware: hw() });
  assert.strictEqual(k.enabled(), false, "a feature most users do not want must not be on");
  assert.deepStrictEqual(await k.status(), { ok: true, enabled: false }, "status leaks nothing while off");
  assert.strictEqual(k._chain, null, "no chain client is constructed");
  await assert.rejects(() => k.balances("1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E"), /switched off/);
  await assert.rejects(() => k.nodeProbe(), /switched off/);
});

test("koinos: switching off again drops the provider and the cache", () => {
  const k = new KoinosService({ settings: store(), hardware: hw() });
  k.setEnabled(true);
  k.chain(); // force construction
  assert.ok(k._chain, "on: a client exists");
  k.setEnabled(false);
  assert.strictEqual(k._chain, null, "off: it is gone again, not just ignored");
});

test("koinos: a Raspberry Pi is refused on ARCHITECTURE, before anything is downloaded", () => {
  const pi = new KoinosService({ settings: store(), hardware: hw({ arch: "arm64", ramBytes: 8 * 1024 ** 3 }) });
  const c = pi.capability();
  assert.strictEqual(c.canRun, false);
  assert.strictEqual(c.reason, "arch", "not 'ram', not 'disk' — the node images have no arm64 build at all");
  // The verdict must be answerable without a network call or an install.
  assert.ok(c.requirements.arch.includes("x64"));
  assert.ok(c.requirements.verifiedOn, "the card shows when these facts were last checked");
});

test("koinos: disk is two thresholds, because 'can run' and 'can quick-sync' differ", () => {
  const s = store();
  const roomy = new KoinosService({ settings: s, hardware: hw({ diskFreeBytes: 200 * 1024 ** 3 }) }).capability();
  assert.strictEqual(roomy.canRun, true);
  assert.strictEqual(roomy.quickSync, true);

  const tight = new KoinosService({ settings: s, hardware: hw({ diskFreeBytes: 60 * 1024 ** 3 }) }).capability();
  assert.strictEqual(tight.canRun, true, "60 GB is enough to run one");
  assert.strictEqual(tight.quickSync, false, "…but not enough to shortcut the sync — a real, separate state");

  const cramped = new KoinosService({ settings: s, hardware: hw({ diskFreeBytes: 20 * 1024 ** 3 }) }).capability();
  assert.strictEqual(cramped.canRun, false);
  assert.strictEqual(cramped.reason, "disk");

  const thin = new KoinosService({ settings: s, hardware: hw({ ramBytes: 4 * 1024 ** 3 }) }).capability();
  assert.strictEqual(thin.canRun, false);
  assert.strictEqual(thin.reason, "ram");
});

test("koinos: settings are validated at the door, not at use", () => {
  const k = new KoinosService({ settings: store(), hardware: hw() });
  k.setEnabled(true);
  assert.throws(() => k.setRpcUrl("127.0.0.1:8080"), /http/, "a bare host:port is the commonest paste and must be caught");
  assert.strictEqual(k.setRpcUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.strictEqual(k.setRpcUrl(""), "", "clearing it falls back to the public RPC");

  assert.throws(() => k.setWatchAddress("1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3X"), /valid Koinos address/, "one flipped character fails the checksum");
  assert.strictEqual(k.setWatchAddress("1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E"), "1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E");
});

test("chain-read: cannot sign — the property the whole stage rests on", () => {
  const c = new ChainRead(store());
  for (const m of ["burn", "transfer", "send", "registerProducerKey", "signHash"]) {
    assert.strictEqual(typeof c[m], "undefined", `${m}() must not exist on a read-only client`);
  }
  // And it never takes a signer, so it can never mutate wallet.js's singleton
  // the way the upstream _contract() does (signer.provider = p) — that object
  // is what core/lib/worker.js signs earn receipts with.
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "chain-read.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  assert.ok(!/signer/.test(code), "the word 'signer' appears nowhere in the executable code");
});

test("chain-read: address validation and amount formatting", () => {
  const c = new ChainRead(store());
  assert.strictEqual(c.isValidAddress("1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E"), true);
  assert.strictEqual(c.isValidAddress("1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3X"), false, "checksum catches a typo");
  assert.strictEqual(c.isValidAddress(""), false);
  assert.strictEqual(c.isValidAddress(null), false);

  // Satoshis are integers; formatting must never go through a float.
  assert.strictEqual(formatKoin("100000000"), "1");
  assert.strictEqual(formatKoin("12345678"), "0.1234");
  assert.strictEqual(formatKoin("0"), "0");
  assert.strictEqual(formatKoin("900719925474099100000000"), "9007199254740991");
  assert.strictEqual(formatKoin("not a number"), "0", "garbage in never throws on a display path");
});

test("chain-read: a user's own node wins over the public RPC", () => {
  const s = store();
  const c = new ChainRead(s);
  assert.deepStrictEqual(c.rpcUrls(), ["https://api.koinos.io"], "public by default");
  s.set("koinos.rpcUrl", "http://127.0.0.1:8080");
  assert.deepStrictEqual(c.rpcUrls(), ["http://127.0.0.1:8080"], "…their node when they point at one");
});

test("chain-read: an unreachable node is an ANSWER, not an exception", async () => {
  const c = new ChainRead(store());
  // Nothing is listening here. The panel must say "not connected", not crash.
  const r = await c.probeNode("http://127.0.0.1:1", null);
  assert.strictEqual(r.connected, false);
  assert.strictEqual(r.reason, "unreachable");
  const none = await c.probeNode("", null);
  assert.strictEqual(none.reason, "no-url");
});

test("koinos: the requirements are DATA, so a hardware fact is one edit", () => {
  // The day arm64 node images ship, this app tells Pi users a lie until
  // someone changes one line. Keeping it as data bounds that blast radius.
  assert.deepStrictEqual(Object.keys(NODE_REQUIREMENTS).sort(),
    ["arch", "minFreeGbForQuickSync", "minFreeGbToRun", "minRamGb", "releasesUrl", "verifiedOn"]);
  assert.match(NODE_REQUIREMENTS.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
});

/* ---------------- §7: Local-Only must mean local ---------------- */

const { Gateway } = require("../lib/gateway");
const { ModelManager } = require("../lib/model-manager");
const { ApiKeys } = require("../lib/keys");

async function gatewayWith(privacyMode, { enabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-kng-"));
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const koinos = new KoinosService({ settings, hardware: hw(), dataDir: dir, onEvent: () => {} });
  koinos.setEnabled(enabled);
  const gw = new Gateway({
    host: "127.0.0.1", port: 0,
    models: new ModelManager({ catalogPath: path.join(__dirname, "..", "models", "catalog.json"), modelsDir: path.join(dir, "m"), state: new JsonStore(path.join(dir, "st.json"), {}), onEvent: () => {} }),
    keys: new ApiKeys(new JsonStore(path.join(dir, "k.json"), {})),
    runtime: { status: () => ({ running: false }) },
    coreInfo: () => ({ version: "t" }),
    network: { status: () => ({ privacyMode }) },
    koinos, onEvent: () => {},
  });
  await gw.listen();
  return { gw, base: `http://127.0.0.1:${gw.port}` };
}

/** Run fn with global fetch replaced by a spy that THROWS if the chain is
 *  touched — the only way to prove "no egress" rather than assert it. */
async function withFetchTrap(fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (...args) => {
    const target = String(args[0] ?? "");
    if (!/^http:\/\/127\.0\.0\.1:/.test(target)) {
      calls.push(target);
      throw new Error("EGRESS in local-only: " + target);
    }
    return real(...args);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test("koinos: Local-Only means LOCAL — the chain is never reached", async () => {
  const { gw, base } = await gatewayWith("local-only");
  try {
    await withFetchTrap(async (calls) => {
      const bal = await fetch(`${base}/core/koinos/balances?address=1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E`);
      assert.strictEqual(bal.status, 403, "an address lookup is refused, not attempted");
      const b = await bal.json();
      assert.strictEqual(b.localOnly, true);
      assert.match(b.error, /Local-Only/, "and it says WHY, so the user can fix it");

      const node = await fetch(`${base}/core/koinos/node`);
      assert.strictEqual(node.status, 403, "so is probing a node");

      assert.deepStrictEqual(calls, [], "nothing left this machine — the promise in the sidebar");
    });
  } finally {
    await gw.close();
  }
});

test("koinos: status still answers in Local-Only, and says the cards are off", async () => {
  const { gw, base } = await gatewayWith("local-only");
  try {
    // Status is local: settings, hardware, a filesystem probe. It must keep
    // working, or the panel cannot EXPLAIN the refusal — it just looks broken.
    const s = await (await fetch(`${base}/core/koinos`)).json();
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.chainReadsAllowed, false, "advertised up front, not discovered by a 403");
    assert.strictEqual(s.privacyMode, "local-only");
    assert.ok(s.capability, "the hardware verdict is local and still useful");
  } finally {
    await gw.close();
  }
});

test("koinos: outside Local-Only the chain routes are allowed through", async () => {
  const { gw, base } = await gatewayWith("local-first");
  try {
    const s = await (await fetch(`${base}/core/koinos`)).json();
    assert.strictEqual(s.chainReadsAllowed, true);
    // Not asserting a successful chain read — that would need the network.
    // What matters is that the PRIVACY gate is not what stops it.
    const bal = await fetch(`${base}/core/koinos/balances?address=not-an-address`);
    assert.notStrictEqual(bal.status, 403, "refused on the address, not on privacy");
  } finally {
    await gw.close();
  }
});

test("koinos: switched off, every mode answers the same inert shape", async () => {
  for (const mode of ["local-only", "local-first", "network"]) {
    const { gw, base } = await gatewayWith(mode, { enabled: false });
    try {
      const s = await (await fetch(`${base}/core/koinos`)).json();
      assert.strictEqual(s.enabled, false, `${mode}: off`);
      assert.strictEqual(s.capability, undefined, `${mode}: nothing else is computed or leaked`);
      assert.strictEqual(s.companion, undefined, `${mode}: no filesystem probe either`);
    } finally {
      await gw.close();
    }
  }
});
