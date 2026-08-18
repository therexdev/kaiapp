"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createKoinosNode } = require("../lib/koinos-node");
const { WalletService } = require("../lib/wallet");

/*
 * The full Koinos node, inside Koinos AI.
 *
 * These pin the two things the port must never get wrong: that it is the SAME
 * wallet, and that the password guards value leaving it.
 */

const PW = "a good password here";
function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-knode-"));
  const wallet = new WalletService(path.join(dir, "wallet"));
  const made = wallet.create({ password: PW });
  const kn = createKoinosNode({ dataDir: dir, wallet, appVersion: "test", onEvent: () => {} });
  return { kn, wallet, made, dir };
}

test("node: the whole Koinos Node surface is present", async () => {
  const { kn } = boot();
  try {
    const c = kn.list();
    // The capabilities the owner asked for by name.
    for (const ch of [
      "node:start", "node:stop", "node:status", "node:logs", "node:quickSync", "node:quickSyncInfo",
      "setup:installWsl", "setup:installDocker", "setup:startDocker", "setup:restart", "setup:status",
      "wallet:status", "wallet:create", "wallet:unlock", "wallet:revealWif",
      "chain:balances", "chain:send", "chain:burn", "chain:maxBurn",
      "producer:register", "producer:status",
      "rewards:status", "rewards:configure", "rewards:runNow",
      "fund:buyUrl", "fund:status", "fund:bridgeStart", "fund:routeCStart", "fund:routeCompare",
      "fund:ethSend", "fund:usdtSend", "fund:vkoinSend", "dashboard:summary",
    ]) {
      assert.ok(c.includes(ch), `${ch} is wired`);
    }
    assert.ok(c.length >= 60, `${c.length} channels`);
  } finally { kn.stop(); }
});

test("node: it is the SAME wallet — Koinos AI's earn keystore, not a second one", async () => {
  const { kn, wallet, made } = boot();
  try {
    const st = await kn.call("wallet:status");
    assert.strictEqual(st.address, made.address, "the node's wallet IS the earn wallet");
    assert.strictEqual(st.address, wallet.address);
    // One key, two chain identities — so one backup code still restores both.
    assert.match(String(st.ethAddress), /^0x[0-9a-fA-F]{40}$/, "and it carries an Ethereum address for funding");
    assert.strictEqual(st.ethAddress, wallet.ethAddress);
  } finally { kn.stop(); }
});

test("node: nothing leaves the wallet without the password", async () => {
  const { kn } = boot();
  try {
    // The wallet is unlocked right now, exactly as it is after Core resumes a
    // session from the OS keychain at start-up, with nobody at the keyboard.
    assert.strictEqual((await kn.call("wallet:status")).unlocked, true);

    const outbound = [
      ["chain:send", { to: "1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E", amount: "1", token: "koin" }],
      ["fund:ethSend", { toAddress: "0x0000000000000000000000000000000000000001", amountEth: "0.01" }],
      ["fund:usdtSend", { toAddress: "0x0000000000000000000000000000000000000001", amountUsdt: "1" }],
      ["fund:vkoinSend", { toAddress: "0x0000000000000000000000000000000000000001", amountVkoin: "1" }],
      ["fund:bridgeStart", { amountEth: "0.01" }],
      ["fund:routeCStart", { amountEth: "0.01", source: "eth" }],
    ];
    for (const [channel, payload] of outbound) {
      await assert.rejects(() => kn.call(channel, payload), /password/i, `${channel} refuses without a password`);
      await assert.rejects(() => kn.call(channel, { ...payload, password: "wrong one" }), /does not match/, `${channel} refuses a wrong password`);
    }
  } finally { kn.stop(); }
});

test("node: reburn is NOT password-gated — it must run unattended", async () => {
  const { kn } = boot();
  try {
    // Reburn converts KOIN into your own VHP at your own address. Nothing
    // leaves, and a node operator's reburn has to keep working while they
    // sleep. Configuring it takes no password.
    const r = await kn.call("rewards:configure", { enabled: true, pct: 50, mode: "burn" });
    assert.ok(r, "reward config accepted with no password");
    const st = await kn.call("rewards:status");
    assert.strictEqual(st.config.enabled, true);
  } finally { kn.stop(); }
});

test("node: an unknown channel is refused rather than silently ignored", async () => {
  const { kn } = boot();
  try {
    await assert.rejects(() => kn.call("chain:drainEverything", {}), /Unknown Koinos channel/);
  } finally { kn.stop(); }
});

test("node: local machine facts are readable with no network and no Docker", async () => {
  const { kn } = boot();
  try {
    const setup = await kn.call("setup:status");
    assert.ok(setup.platform, "reports the platform");
    assert.ok(setup.docker, "and whether Docker is installed/running");
    const node = await kn.call("node:status");
    assert.ok(node.network, "node status answers even with the engine down");
    const info = await kn.call("app:info");
    assert.ok(info.networks.mainnet, "mainnet is configured");
  } finally { kn.stop(); }
});
