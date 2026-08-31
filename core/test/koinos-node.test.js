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

/*
 * Sending returns to ANOTHER address is the same class of act as chain:send,
 * and for longer: it is a standing instruction that moves value repeatedly,
 * on its own, while nobody is watching. The wallet auto-unlocks at start-up,
 * so "unlocked" proves nothing about who is asking — which is the whole reason
 * this file exists. Arming that destination went un-gated (FIND-KOI-001).
 */

test("node: arming automatic sends to another address proves the password", async () => {
  const { kn } = boot();
  const THEIRS = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK"; // not this wallet
  try {
    await assert.rejects(
      () => kn.call("rewards:configure", { enabled: true, pct: 50, mode: "send", toAddress: THEIRS }),
      /wallet password/i,
      "a caller could arm returns to any address without proving anything",
    );
    await assert.rejects(
      () => kn.call("rewards:configure", { enabled: true, pct: 50, mode: "send", toAddress: THEIRS, password: "not the password" }),
      /.+/,
      "a wrong password must not arm it either",
    );

    // Nothing was armed by either attempt.
    let st = await kn.call("rewards:status");
    assert.notStrictEqual(st.config.mode, "send", "a refused call must not have taken effect");

    // With the password, the owner can still do it.
    await kn.call("rewards:configure", { enabled: true, pct: 50, mode: "send", toAddress: THEIRS, password: PW });
    st = await kn.call("rewards:status");
    assert.strictEqual(st.config.mode, "send");
    assert.strictEqual(st.config.toAddress, THEIRS);
  } finally { kn.stop(); }
});

test("node: repointing an already-armed destination proves the password again", async () => {
  const { kn } = boot();
  const FIRST = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK";
  const ELSEWHERE = "1NsyZDCnHcm1rGFoUaUgHWs2FrsbQFqp2Q";
  try {
    await kn.call("rewards:configure", { enabled: true, pct: 50, mode: "send", toAddress: FIRST, password: PW });
    // The dangerous case: returns are already flowing, and the destination is
    // quietly swapped. One proof at arming time would not have covered this.
    await assert.rejects(
      () => kn.call("rewards:configure", { toAddress: ELSEWHERE }),
      /wallet password/i,
      "the destination was changed with no proof",
    );
    const st = await kn.call("rewards:status");
    assert.strictEqual(st.config.toAddress, FIRST, "the original destination must stand");
  } finally { kn.stop(); }
});

test("node: the rest of the returns settings still need no password", async () => {
  const { kn } = boot();
  const THEIRS = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK";
  try {
    await kn.call("rewards:configure", { enabled: true, pct: 50, mode: "send", toAddress: THEIRS, password: PW });
    // None of these can move a satoshi anywhere new, and a node operator has
    // to be able to tune them without a password prompt every time.
    for (const patch of [{ pct: 10 }, { minReturnKoin: "2" }, { maxReturnKoin: "5" }, { pollMinutes: 30 }, { enabled: false }]) {
      await kn.call("rewards:configure", patch);
    }
    const st = await kn.call("rewards:status");
    assert.strictEqual(st.config.pct, 10);
    assert.strictEqual(st.config.enabled, false);
  } finally { kn.stop(); }
});

test("node: the password is never written into the returns config", async () => {
  const { kn, dir } = boot();
  const THEIRS = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK";
  try {
    await kn.call("rewards:configure", { enabled: true, pct: 50, mode: "send", toAddress: THEIRS, password: PW });
    const st = await kn.call("rewards:status");
    assert.ok(!("password" in st.config), "the password must not survive into the config object");

    // And it must not be sitting in any file this call wrote, which is the
    // failure that would matter far more than the one being fixed.
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(d, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });
    for (const f of walk(dir)) {
      let text = "";
      try { text = fs.readFileSync(f, "utf8"); } catch { continue; } // binary/unreadable
      assert.ok(!text.includes(PW), `the wallet password was written to ${f}`);
    }
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

test("node UI: every channel the vendored renderer calls actually exists", async () => {
  const { kn } = boot();
  try {
    const real = new Set(kn.list());
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "ui", "knode", "renderer.js"), "utf8");
    const called = [...src.matchAll(/call\(\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(called.length >= 40, `the renderer calls ${called.length} channels`);
    // The bridge satisfies the clipboard itself; everything else must land on
    // a real handler, or a button in the vendored UI dies only when clicked.
    for (const ch of new Set(called)) {
      if (ch === "util:copy") continue;
      assert.ok(real.has(ch), `renderer calls ${ch}, which Core does not handle`);
    }
  } finally { kn.stop(); }
});

test("node UI: the bridge's password gate covers exactly Core's outbound channels", async () => {
  const bridge = fs.readFileSync(path.join(__dirname, "..", "..", "ui", "knode", "bridge.js"), "utf8");
  // The six channels Core refuses without a proved password. If a new
  // outbound channel appears in Core, it must appear here too, or its button
  // in the vendored UI will fail with "password required" and no way to give one.
  const outbound = ["chain:send", "fund:bridgeStart", "fund:routeCStart", "fund:ethSend", "fund:usdtSend", "fund:vkoinSend"];
  for (const ch of outbound) {
    assert.ok(bridge.includes(`"${ch}"`), `${ch} is password-gated in the bridge`);
  }
  const coreSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "koinos-node.js"), "utf8");
  // The definition is an arrow (`requirePassword = (`), so these six are the
  // six call sites: bridgeStart, routeCStart, ethSend, usdtSend, vkoinSend,
  // and the returns destination added for FIND-KOI-001.
  const gated = coreSrc.match(/requirePassword\(password\)/g)?.length ?? 0;
  assert.strictEqual(gated, 6, "Core still gates six channels via requirePassword");
  assert.match(coreSrc, /chain\.transfer\(wallet\.signerFor\(password\)/, "and chain:send proves the password via signerFor");

  /*
   * rewards:configure is the one CONDITIONALLY gated channel, and it must stay
   * out of OUTBOUND. Everything in that map prompts on every call, which is
   * right for "send this money now" and wrong here: most saves only move a
   * percentage slider, and a password box in front of each one teaches people
   * to type their wallet password without reading why. So the returns screen
   * carries its own field, shown only when a destination is in play, and Core
   * decides whether it was actually needed.
   */
  assert.ok(!/"rewards:configure"/.test(bridge.slice(bridge.indexOf("var OUTBOUND"), bridge.indexOf("/** Ask for the wallet password"))),
    "rewards:configure must not be in OUTBOUND — it would prompt on every save");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "..", "ui", "knode", "renderer.js"), "utf8");
  assert.match(renderer, /id="r-pass"[^>]*type="password"/, "the returns screen needs its own password field");
  assert.match(renderer, /rewards:configure[\s\S]{0,600}password: pass/, "and it must actually send it");
});

test("node UI: the switch reveals every node menu, and the embedded app is wired in", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "ui", "index.html"), "utf8");
  const knodeHtml = fs.readFileSync(path.join(__dirname, "..", "..", "ui", "knode", "index.html"), "utf8");
  const hostView = fs.readFileSync(path.join(__dirname, "..", "..", "ui", "koinos-node-view.js"), "utf8");
  /*
   * v0.41.0: ONE sidebar entry, seven screens on a rail inside the view — the
   * Koinos Code shape. Seven top-level entries made an optional feature look
   * like most of the app, and they stayed in the way even when only one was
   * ever used. The screens are unchanged; only where you choose between them
   * moved, so the rail must still cover every embedded view.
   */
  const navs = [...html.matchAll(/class="nav-item koinos-nav" data-view="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(navs, ["koinos"], "one sidebar entry for the whole node");
  const rail = [...html.matchAll(/data-knode="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(rail.length, 7, "seven screens on the rail");
  assert.strictEqual(rail[0], "koinos", "Dashboard is first");
  for (const v of rail) assert.ok(hostView.includes(`"${v}"`), `${v} maps to an embedded view`);
  // Every embedded view stays reachable — a rail that lost one would strand it.
  const mapped = [...hostView.matchAll(/"(koinos[a-z-]*)":\s*"/g)].map((m) => m[1]);
  for (const v of mapped) assert.ok(rail.includes(v), `${v} is reachable from the rail`);
  assert.ok(html.includes('id="koinos-frame-host"'), "the koinos view hosts the iframe");
  // A button that says "Turn on" is a link pretending to be a switch. This is
  // the control the owner asked for by name.
  assert.match(html, /id="btn-koinos-toggle"[^>]*role="switch"/, "it is a real switch");
  assert.ok(html.includes('class="nav-item koinos-nav" data-view="koinos" id="nav-koinos" hidden'), "and the menus start hidden");
  // The vendored page loads the bridge before the renderer, and its CSP
  // permits the fetches the bridge makes in place of Electron IPC.
  assert.ok(knodeHtml.indexOf("bridge.js") < knodeHtml.indexOf("renderer.js"), "bridge loads first");
  assert.match(knodeHtml, /connect-src 'self'/, "CSP allows same-origin fetch + SSE");
});

test("wallet: a pre-funding keystore gets its ETH address on session resume (field report)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-oldwallet-"));
  const secret = "os-held-machine-secret";
  const w1 = new WalletService(path.join(dir, "wallet"));
  w1.create({ password: PW });
  w1.saveSession(secret);

  // Age the keystore: installs from before funding existed have no ethAddress.
  const ksPath = path.join(dir, "wallet", "wallet.json");
  const ks = JSON.parse(fs.readFileSync(ksPath, "utf8"));
  delete ks.ethAddress;
  fs.writeFileSync(ksPath, JSON.stringify(ks));

  // A fresh boot resumes the session — the only open most users ever do.
  const w2 = new WalletService(path.join(dir, "wallet"));
  assert.strictEqual(w2.ethAddress, null, "aged keystore starts with no ETH address");
  assert.ok(w2.tryResumeSession(secret), "session resumes");
  assert.match(String(w2.ethAddress), /^0x[0-9a-fA-F]{40}$/, "resume backfills the ETH address");
  assert.strictEqual(
    JSON.parse(fs.readFileSync(ksPath, "utf8")).ethAddress,
    w2.ethAddress,
    "…and persists it, so it shows even while locked from now on"
  );

  // And the node surface built on top now offers funding instead of asking
  // for an unlock that is nowhere to be found.
  const kn = createKoinosNode({ dataDir: dir, wallet: w2, appVersion: "test", onEvent: () => {} });
  try {
    const f = await kn.call("fund:status");
    assert.strictEqual(f.ethAddress, w2.ethAddress);
    const st = await kn.call("wallet:status");
    assert.strictEqual(st.ethAddress, w2.ethAddress);
    assert.strictEqual(st.unlocked, true);
  } finally { kn.stop(); }
});

test("setup: Start Docker installs Docker Desktop when the app is missing (field report)", async () => {
  const { SetupService } = require("../lib/koinos/setup");
  const { JsonStore } = require("../lib/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-setup-"));
  const events = [];
  const setup = new SetupService({
    platform: "win32",
    arch: "x64",
    downloadDir: path.join(dir, "dl"),
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: (e) => events.push(e),
  });
  // The field case: a leftover docker CLI made Docker look installed, but the
  // Desktop app is gone. The old code answered "Install it first." — thrown
  // at the person pressing the install-shaped button.
  setup._dockerAppInstalled = () => null;
  let installs = 0;
  setup.installDocker = async () => { installs += 1; return { started: true }; };

  const r = await setup.startDocker(); // old code: throws here
  assert.strictEqual(r.installing, true, "the button cascades into the install");
  assert.strictEqual(installs, 1, "…exactly once");
  assert.ok(events.some((e) => /downloading it now/i.test(e.message || "")), "…and says so");

  // With the app present, it starts it rather than reinstalling. The spawn
  // target does not exist here, which is exactly why the ENOENT guard on
  // these spawns must hold.
  setup._dockerAppInstalled = () => path.join(dir, "Docker Desktop.exe");
  const started = await setup.startDocker().catch((e) => ({ error: e.message }));
  assert.strictEqual(started.started, true, String(started.error || ""));
  assert.strictEqual(installs, 1, "no second install");
});

test("setup: when the installer finishes, Docker is detected and started unprompted (field report)", async () => {
  const { SetupService } = require("../lib/koinos/setup");
  const { JsonStore } = require("../lib/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-postinstall-"));
  const events = [];
  const setup = new SetupService({
    platform: "win32",
    arch: "x64",
    downloadDir: path.join(dir, "dl"),
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: (e) => events.push(e),
  });
  setup._installPollMs = 30; // fast polls for the test
  setup._dockerAppFromRegistry = async () => null;

  // The field timeline: watcher armed while the installer's UI is still up…
  let appOnDisk = null;
  let started = 0;
  setup._dockerAppInstalled = () => appOnDisk;
  setup.startDocker = async () => { started += 1; return { started: true }; };
  setup._watchInstallDone();

  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(started, 0, "nothing starts while the installer is still running");

  // …then the installer finishes and Docker Desktop lands on disk.
  appOnDisk = path.join(dir, "Docker Desktop.exe");
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(started, 1, "Docker is started without the user doing anything");
  assert.ok(events.some((e) => /installed — starting it now/i.test(e.message || "")), "…and the app says so");

  setup.stopWatchers();
});

test("setup: the Windows registry finds a Docker Desktop installed anywhere (field report)", async () => {
  const { SetupService } = require("../lib/koinos/setup");
  const { JsonStore } = require("../lib/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-reg-"));
  const exe = path.join(dir, "Docker Desktop.exe");
  fs.writeFileSync(exe, "");
  const setup = new SetupService({
    platform: "win32",
    arch: "x64",
    downloadDir: path.join(dir, "dl"),
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: () => {},
  });
  // Custom install location: none of the hardcoded paths exist, only the
  // uninstall registry entry knows where it went.
  setup._dockerAppInstalled = () => null;
  setup._exec = async (bin, args) =>
    bin === "reg" && args[1].startsWith("HKLM")
      ? { ok: true, stdout: `\n    InstallLocation    REG_SZ    ${dir}\n`, stdoutRaw: Buffer.from(`\n    InstallLocation    REG_SZ    ${dir}\n`) }
      : { ok: false, stdout: "", stderr: "", stdoutRaw: Buffer.alloc(0) };

  assert.strictEqual(await setup._dockerApp(), exe, "the registry locates the install");
  const d = await setup.detectDocker().catch(() => null);
  assert.ok(d && d.installed && d.appPath === exe, "detectDocker reports it installed there");
});
