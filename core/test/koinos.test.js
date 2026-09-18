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
  assert.deepStrictEqual(c.rpcUrls(), ["https://api.koinosblocks.com", "https://api.koinos.io"], "public primary and backup by default");
  s.set("koinos.rpcUrl", "http://127.0.0.1:8080");
  assert.deepStrictEqual(c.rpcUrls(), ["http://127.0.0.1:8080", "https://api.koinosblocks.com", "https://api.koinos.io"], "their node first, with public backups");
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

/* ---------------- Node networking is independent of AI privacy ---------------- */

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

test("koinos: enabling node tools allows chain reads in every AI privacy mode", async () => {
  for (const mode of ["local-only", "local-first", "network"]) {
    const { gw, base } = await gatewayWith(mode, { enabled: false });
    try {
      const enabled = await fetch(`${base}/core/koinos/config`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      assert.strictEqual((await enabled.json()).enabled, true);
      const s = await (await fetch(`${base}/core/koinos`)).json();
      assert.strictEqual(s.chainReadsAllowed, true);
      assert.strictEqual(s.privacyMode, mode, "node opt-in never changes AI privacy");
      const calls = [];
      gw.koinos._chain = {
        balances: async address => { calls.push("balances"); return { address, koin: "1" }; },
        headInfo: async () => { calls.push("head"); return { height: "10" }; },
        probeNode: async () => { calls.push("probe"); return { connected: true }; },
      };
      const bal = await fetch(`${base}/core/koinos/balances?address=fixture`);
      assert.strictEqual(bal.status, 200);
      assert.strictEqual((await bal.json()).koin, "1");
      const node = await fetch(`${base}/core/koinos/node`);
      assert.strictEqual(node.status, 200);
      assert.strictEqual((await node.json()).connected, true);
      assert.deepStrictEqual(calls, ["balances", "head", "probe"]);
    } finally { await gw.close(); }
  }
});

test("koinos: full node UI loads in Local-Only; AI egress and wallet guards still apply", async () => {
  const { gw, base } = await gatewayWith("local-only");
  const { createKoinosNode } = require("../lib/koinos-node");
  const { WalletService } = require("../lib/wallet");
  const wallet = new WalletService(path.join(gw.koinos.dataDir, "wallet"));
  wallet.create({ password: "node privacy fixture password" });
  const node = createKoinosNode({ dataDir: gw.koinos.dataDir, wallet, appVersion: "privacy-fixture" });
  gw.koinosNode = node;
  gw.account = { status() { throw new Error("Account client must not be called"); } };
  const rpc = (channel, payload = {}, headers = {}) => fetch(`${base}/core/koinos/rpc`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ channel, payload }),
  });
  try {
    await withFetchTrap(async calls => {
      const info = await rpc("app:info");
      assert.strictEqual(info.status, 200, "the request that used to crash the node UI");
      assert.strictEqual((await info.json()).data.version, "privacy-fixture");
      assert.strictEqual((await rpc("wallet:status")).status, 200);
      for (const password of [undefined, "wrong password"]) {
        const sent = await rpc("chain:send", { to: wallet.address, amount: "1", token: "koin", password });
        assert.strictEqual(sent.status, 400);
        assert.match((await sent.json()).error, /password|does not match/i);
      }
      assert.strictEqual((await rpc("app:info", {}, { origin: "https://other.example" })).status, 403);
      gw.coreToken = "node-fixture-token";
      assert.strictEqual((await rpc("app:info")).status, 401);
      assert.strictEqual((await rpc("app:info", {}, { authorization: "Bearer node-fixture-token" })).status, 200);
      gw.coreToken = null;
      for (const route of ["search", "fetch"]) {
        const res = await fetch(`${base}/core/${route}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: "test", url: "https://example.com" }),
        });
        assert.strictEqual(res.status, 403, "AI web access stays blocked");
      }
      const account = await fetch(`${base}/core/account`);
      assert.strictEqual(account.status, 403);
      assert.strictEqual((await account.json()).localOnly, true);
      assert.strictEqual(gw.network.status().privacyMode, "local-only");
      assert.deepStrictEqual(calls, [], "no live network or transaction needed for this regression");
    });
  } finally { node.stop(); await gw.close(); }
});

test("koinos: switched off, every mode answers the same inert shape", async () => {
  for (const mode of ["local-only", "local-first", "network"]) {
    const { gw, base } = await gatewayWith(mode, { enabled: false });
    try {
      const s = await (await fetch(`${base}/core/koinos`)).json();
      assert.strictEqual(s.enabled, false, `${mode}: off`);
      assert.strictEqual(s.chainReadsAllowed, false);
      for (const route of ["balances?address=fixture", "node"]) {
        const res = await fetch(`${base}/core/koinos/${route}`);
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /switched off/);
      }
      assert.strictEqual(gw.koinos._chain, null, "disabled tools never construct a chain client");
      assert.strictEqual(s.capability, undefined, `${mode}: nothing else is computed or leaked`);
      assert.strictEqual(s.companion, undefined, `${mode}: no filesystem probe either`);
    } finally {
      await gw.close();
    }
  }
});

/* ---------------- stage 2: writes that sign but move nothing away ---------- */

const { WalletService } = require("../lib/wallet");
const { ChainWrite, MANA_CUSHION } = require("../lib/chain-write");

const PASSWORD = "a real password here";
function walletWith() {
  const w = new WalletService(fs.mkdtempSync(path.join(os.tmpdir(), "kai-kw-")));
  const made = w.create({ password: PASSWORD });
  return { wallet: w, address: made.address };
}

test("stage 2: the password is proved on EVERY call, not once at unlock", async () => {
  const { wallet } = walletWith();
  const k = new KoinosService({ settings: store(), hardware: hw(), wallet });
  k.setEnabled(true);
  // The wallet is unlocked right now — create() leaves it so, exactly as the
  // app does when it resumes a session from the OS keychain at boot.
  assert.strictEqual(wallet.status().unlocked, true, "precondition: unlocked, with no human present");

  await assert.rejects(() => k.burn({ amountKoin: "1", password: "" }), /Enter your wallet password/,
    "an unlocked wallet does NOT excuse a missing password");
  await assert.rejects(() => k.burn({ amountKoin: "1", password: "not it" }), /does not match/,
    "nor a wrong one");
  await assert.rejects(() => k.registerKey({ publicKey: "abcdefghijklmnopqrstuvwx", password: "not it" }), /does not match/);
});

test("stage 2: a one-shot signer never aliases the earn worker's", () => {
  const { wallet, address } = walletWith();
  const a = wallet.signerFor(PASSWORD);
  const b = wallet.signerFor(PASSWORD);
  assert.strictEqual(a.getAddress(), address);
  assert.notStrictEqual(a, b, "each call gets its own object");
  assert.notStrictEqual(a, wallet.signer, "and none of them is the singleton");

  // koilib's Contract does `signer.provider = p`. If chain code were handed
  // the singleton, that assignment would land on the object core/lib/worker.js
  // signs earn receipts with.
  a.provider = { sentinel: true };
  assert.strictEqual(wallet.signer.provider, undefined, "mutating the derived signer does not reach the wallet's");
});

test("stage 2: burn amounts are parsed exactly, never through a float", async () => {
  const { wallet } = walletWith();
  const k = new KoinosService({ settings: store(), hardware: hw(), wallet });
  k.setEnabled(true);
  for (const bad of ["", "abc", "-1", "1.234567890", "1e8", "  "]) {
    await assert.rejects(() => k.burn({ amountKoin: bad, password: PASSWORD }), /amount in KOIN/, `refused: ${JSON.stringify(bad)}`);
  }
});

test("stage 2: mana cushion refuses the burn that reverts on chain", () => {
  const w = new ChainWrite(store());
  const KOIN = 100000000n;
  assert.strictEqual(w.burnableFromMana((10n * KOIN).toString()), (9n * KOIN).toString(), "one KOIN is held back for the transaction's own cost");
  assert.strictEqual(w.burnableFromMana((KOIN / 2n).toString()), "0", "below the cushion, nothing is burnable");
  assert.strictEqual(MANA_CUSHION, KOIN);

  // The exact failure koinos-node hit: a burn sized at the mana limit is
  // accepted by the app and then reverts with an opaque "could not burn KOIN".
  assert.throws(() => w._assertMana((10n * KOIN).toString(), (10n * KOIN).toString()), /Not enough mana/);
  assert.doesNotThrow(() => w._assertMana((9n * KOIN).toString(), (10n * KOIN).toString()));
});

test("stage 2: burning credits the SAME address — it is not a transfer in disguise", () => {
  // burn_address and vhp_address are hardcoded to the signer's own address and
  // are deliberately not parameterised. The moment VHP could be minted
  // elsewhere this becomes a send, and would need the send rules.
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "chain-write.js"), "utf8");
  assert.match(src, /burn_address: address/);
  assert.match(src, /vhp_address: address/);
  assert.ok(!/vhpAddress/.test(src), "no caller-supplied VHP destination exists");
});

test("stage 2: still no way to send KOIN anywhere", () => {
  const w = new ChainWrite(store());
  for (const m of ["transfer", "send"]) assert.strictEqual(typeof w[m], "undefined", `${m}() is stage 3`);
  const gw = fs.readFileSync(path.join(__dirname, "..", "lib", "gateway.js"), "utf8");
  assert.ok(!/koinos\/send/.test(gw), "and no route offers it");
});

test("stage 2: Local-Only preserves password checks on explicit node writes", async () => {
  const { gw, base } = await gatewayWith("local-only");
  const { wallet } = walletWith();
  gw.koinos.wallet = wallet;
  try {
    await withFetchTrap(async calls => {
      for (const p of ["/core/koinos/burn", "/core/koinos/register-key"]) {
        for (const password of [undefined, "wrong password"]) {
          const r = await fetch(`${base}${p}`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ amountKoin: "1", publicKey: "abcdefghijklmnopqrstuvwx", password }),
          });
          assert.strictEqual(r.status, 400);
          assert.match((await r.json()).error, /password|does not match/i);
        }
      }
      assert.deepStrictEqual(calls, [], "password refusal happens before chain access");
    });
  } finally { await gw.close(); }
});
