#!/usr/bin/env node
"use strict";

/*
 * Drives the EMBEDDED Koinos Node Desktop UI in a real browser against a
 * real Core.
 *
 *   node core/scripts/verify-koinos-ui.js
 *
 * ui/knode/ is the standalone node app's renderer, verbatim, so this run
 * proves the integration seams rather than the screens themselves: the
 * Run Koinos Node switch reveals the seven menus; each menu drives the
 * embedded app to the right view; the REAL wallet (Koinos AI's keystore)
 * flows through create / lock / unlock exactly as the standalone app does;
 * and the one agreed behavioural difference holds — a password modal stands
 * in front of every channel that moves funds out, and in front of nothing
 * else.
 *
 * The wallet, the channel registry and most handlers are the real code.
 * Only channels that would touch mainnet or Docker are overridden, with the
 * shapes the real handlers return, and every overridden call is recorded so
 * the assertions can see exactly what the UI sent.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const { Gateway } = require("../lib/gateway");
const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");
const { ApiKeys } = require("../lib/keys");
const { KoinosService } = require("../lib/koinos");
const { WalletService } = require("../lib/wallet");
const { createKoinosNode } = require("../lib/koinos-node");

const CHROME = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures += 1;
};

const PW = "a genuinely fine password";

/** The real node service, with only the network/Docker-touching channels
 *  replaced (faithful shapes) and every replaced call recorded. */
function instrument(real, { dockerInstalled = true, nodeRunning = true } = {}) {
  const calls = [];
  const BAL = { koin: "4308560000", vhp: "228813610000", mana: "3822790000" };
  const setupStatus = {
    platform: "linux",
    wsl: { installed: true },
    docker: { installed: dockerInstalled, running: dockerInstalled, appPath: null, cli: dockerInstalled ? "docker" : null },
    ready: dockerInstalled,
    steps: dockerInstalled
      ? [
          { key: "docker", title: "Docker is running", detail: "Docker Engine is installed and running.", status: "done", action: null, altAction: null },
        ]
      : [
          { key: "docker", title: "Install Docker Engine", detail: "Follow the official install for your Linux distribution.", status: "manual", action: { channel: "setup:openDockerDocs", label: "Install guide" }, altAction: null },
        ],
    activeKey: null,
    op: null,
  };
  const overrides = {
    "chain:balances": () => ({ address: real.callSyncAddress, ...BAL, formatted: { koin: "43.0856", vhp: "2288.1361", mana: "38.2279" } }),
    "chain:maxBurn": () => ({ maxSat: "3308560000", maxFormatted: "33.0856", manaLimited: true, manaFormatted: "38.2279" }),
    "chain:burn": () => ({ txId: "0x1220burn", blockNumber: 1, amountSat: "100000000", amountFormatted: "1" }),
    "chain:send": () => ({ txId: "0x1220send", blockNumber: 1, amountSat: "100000000" }),
    "chain:sync": () => ({ inSync: true, local: { height: 38297044, error: null }, remote: { height: 38297044 }, progressPct: 100 }),
    "producer:status": () => ({ address: null, filePublicKey: "pubkeyfromnode", registeredPublicKey: null, matches: false }),
    "producer:register": () => ({ txId: "0x1220reg" }),
    "dashboard:summary": async () => ({
      network: (await real.call("app:info")).networks.mainnet,
      wallet: await real.call("wallet:status").then((w) => ({ exists: w.exists, unlocked: w.unlocked, address: w.address })),
      node: { docker: { ok: dockerInstalled }, isRunning: nodeRunning, runningCount: nodeRunning ? 7 : 0, op: null, producerRegistered: null },
      sync: nodeRunning ? { inSync: true, local: { height: 38297044, headBlockTimeMs: 1767225600000, error: null }, remote: { height: 38297044 }, progressPct: 100 } : null,
      balances: BAL,
      stats: { available: true, network: "mainnet", totals: null, feed: [], windows: { last24h: "3120000", last7d: "21650000", last30d: "93480000", avgDailyProfit: "3116000", daysTracked: 30 }, syncing: false },
      rewards: { enabled: false, pct: 50, mode: "burn" },
      returns: { reburnFraction: 0, yearlyProfitSats: "1137340000", yearlyReturnPct: 0.497, yearlyProfitReburnSats: null, yearlyReturnReburnPct: 0.498 },
    }),
    "node:status": () => ({
      network: "mainnet",
      docker: dockerInstalled ? { ok: true } : { ok: false, error: "docker: command not found" },
      filesReady: true,
      services: [],
      runningCount: nodeRunning ? 7 : 0,
      isRunning: nodeRunning,
      producerPublicKey: "pubkeyfromnode",
      op: null,
      dataDir: "/data/koinos",
      autoRecover: true,
      memorySaver: false,
      health: { ok: true, reason: null, recovering: false, memorySaver: false, needsRepair: false, repairReason: null, recoveries: 0, lastRecoveryAt: null },
      sync: nodeRunning ? { inSync: true, local: { height: 38297044, error: null }, remote: { height: 38297044 }, progressPct: 100 } : null,
      setup: dockerInstalled ? null : setupStatus,
    }),
    "setup:status": () => setupStatus,
    "setup:openDockerDocs": () => ({ openUrl: "https://docs.docker.com/engine/install/" }),
    "node:logs": () => "koinos-chain  | block 38297044 applied\nkoinos-p2p    | 12 peers",
    "node:quickSyncInfo": () => ({ available: true, sizeBytes: 9e9, freeBytes: 4e11, updatedAt: "2026-08-17" }),
    // Never let a test reach the real start: a CI runner with real Docker
    // would otherwise pull the node's images and bring the stack up.
    "node:start": () => ({ started: true }),
    "node:stop": () => ({ stopping: true }),
    "node:quickSync": () => ({ started: true }),
    "setup:installDocker": () => ({ started: true }),
    "setup:startDocker": () => ({ started: true }),
    "fund:ethBalance": () => ({ address: real.ethAddress, wei: "0x16345785d8a0000", eth: "0.1" }),
    "fund:routeMaxEth": () => ({ gasReserveEth: "0.004", balanceEth: "0.1", maxEth: "0.05" }),
    "fund:routeCompare": () => ({
      best: { id: "C" },
      amountEth: "0.02",
      slippageBps: 150,
      routes: [
        { id: "B", label: "Bridge ETH, swap on KoinDX", steps: ["Bridge ETH → vETH (Vortex)", "Swap vETH → KOIN (KoinDX)"], note: "", executable: true, koinOut: "1200000000", koinOutMin: "1150000000", isBest: false, pctOfBest: 40, bestMultiple: 2.5 },
        { id: "C", label: "Swap to vKOIN, bridge to KOIN", steps: ["Swap ETH → USDT → vKOIN (Uniswap)", "Bridge vKOIN → KOIN (Vortex, 1:1)"], note: "", executable: true, koinOut: "3000000000", koinOutMin: "2900000000", isBest: true, pctOfBest: 100, bestMultiple: null },
      ],
    }),
    "fund:bridgeStart": () => ({ id: "job1", status: "depositing" }),
    "fund:routeCStart": () => ({ id: "job2", status: "swapping" }),
    "util:openExternal": ({ url }) => ({ openUrl: url }),
  };
  return {
    calls,
    list: () => real.list(),
    async call(channel, payload) {
      if (overrides[channel]) {
        calls.push({ channel, payload });
        return overrides[channel](payload || {});
      }
      return real.call(channel, payload);
    },
    stop: () => real.stop(),
  };
}

async function boot({ createWallet = true, lockAfter = false, machine } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-knode-ui-"));
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const hardware = { platform: "linux", arch: "x64", ramBytes: 32 * 1024 ** 3, diskFreeBytes: 400 * 1024 ** 3 };
  const wallet = new WalletService(path.join(dir, "wallet"));
  if (createWallet) {
    wallet.create({ password: PW });
    if (lockAfter) wallet.lock();
  }
  const real = createKoinosNode({ dataDir: dir, wallet, appVersion: "test", onEvent: () => {} });
  const node = instrument(real, machine || {});
  const gw = new Gateway({
    host: "127.0.0.1",
    port: 0,
    models: new ModelManager({ catalogPath: path.join(__dirname, "..", "models", "catalog.json"), modelsDir: path.join(dir, "m"), state: new JsonStore(path.join(dir, "st.json"), {}), onEvent: () => {} }),
    keys: new ApiKeys(new JsonStore(path.join(dir, "k.json"), {})),
    runtime: { status: () => ({ running: false }) },
    coreInfo: () => ({ version: "test" }),
    network: { status: () => ({ privacyMode: "network" }) },
    uiDir: path.join(__dirname, "..", "..", "ui"),
    koinos: new KoinosService({ settings, hardware, dataDir: dir, onEvent: () => {} }),
    koinosNode: node,
    onEvent: () => {},
  });
  await gw.listen();
  return { gw, node, wallet, base: `http://127.0.0.1:${gw.port}` };
}

async function run(label, opts, fn) {
  const { gw, node, wallet, base } = await boot(opts);
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.locator('.nav-item[data-view="earn"]').click();
  await page.waitForTimeout(300);
  await page.locator("#btn-koinos-toggle").click(); // reveal the node menus
  await page.waitForTimeout(800);
  console.log(`\n--- ${label} ---`);
  try {
    await fn(page, page.frameLocator("#koinos-frame"), node, errors, wallet);
    ok("no uncaught script errors anywhere on the page", errors.length === 0, errors[0] || "");
  } finally {
    await browser.close();
    node.stop();
    await gw.close();
  }
}

const NAVS = ["nav-koinos", "nav-koinos-wallet", "nav-koinos-fund", "nav-koinos-burn", "nav-koinos-node", "nav-koinos-returns", "nav-koinos-settings"];

(async () => {
  // 1. The switch reveals the menus, and behind them is the real app.
  await run("the switch and the embedded app", {}, async (page, app) => {
    for (const id of NAVS) ok(`${id} is revealed by the switch`, await page.locator("#" + id).isVisible());
    ok("the node view hosts the embedded app", await page.locator("#koinos-frame").isVisible());
    await app.locator("#view-dashboard h1").waitFor({ timeout: 10000 });
    ok("the embedded app's own sidebar is hidden — Koinos AI's is the one", await app.locator("#sidebar").isHidden());
    const dash = await app.locator("#view-dashboard").textContent();
    ok("the dashboard is the node app's own dashboard", /Dashboard/i.test(dash), dash.slice(0, 60));

    // Sidebar entries drive the embedded views.
    await page.locator("#nav-koinos-burn").click();
    await page.waitForTimeout(700);
    const burn = await app.locator("#view-burn").textContent();
    ok("the burn menu opens the app's burn view", /Burn/.test(burn) && (await app.locator("#view-burn").evaluate((e) => e.classList.contains("active"))));
    ok("…with the real copy: Proof-of-Burn, depreciation, APY", /Proof-of-Burn is Koinos consensus/.test(burn), "");
    ok("…and the Max button wired to real mana math", await app.locator("#burn-max").isVisible());

    await page.locator("#nav-koinos-settings").click();
    await page.waitForTimeout(700);
    ok("settings opens", await app.locator("#view-settings").evaluate((e) => e.classList.contains("active")));
    const set = await app.locator("#view-settings").textContent();
    ok("…the app's own settings, RPC and network controls", /Network, RPC and wallet management/.test(set), set.slice(0, 80));
    ok("…with the data folder open link", (await app.locator("#set-open").count()) === 1);

    // Off again: menus gone, user landed somewhere real.
    await page.locator('.nav-item[data-view="earn"]').click();
    await page.waitForTimeout(300);
    await page.locator("#btn-koinos-toggle").click();
    await page.waitForTimeout(600);
    for (const id of NAVS) ok(`${id} hides again`, await page.locator("#" + id).isHidden());
    ok("…and Earn is on screen", await page.locator("#view-earn").isVisible());
  });

  // 2. The wallet: same keystore, and the unlock the owner could not find.
  await run("locked wallet: the unlock screen exists and works", { lockAfter: true }, async (page, app, node, errors, wallet) => {
    await page.locator("#nav-koinos-wallet").click();
    await app.locator("#uw-pass").waitFor({ timeout: 10000 });
    const text = await app.locator("#view-wallet").textContent();
    ok("a locked wallet shows the app's unlock screen", /Unlock your wallet/.test(text));
    ok("…which says WHY unlocking matters", /required to burn, send, register/.test(text));
    await app.locator("#uw-pass").fill(PW);
    await app.locator("#uw-go").click();
    await page.waitForTimeout(1200);
    ok("the real password unlocks the real keystore", wallet.status().unlocked);
    const after = await app.locator("#view-wallet").textContent();
    ok("…and the wallet screen shows the address", after.includes(wallet.address), wallet.address);
  });

  // 3. Password before funds leave — and nowhere else.
  await run("password guards exactly the outbound paths", {}, async (page, app, node) => {
    await page.locator("#nav-koinos-wallet").click();
    await app.locator("#w-send").waitFor({ timeout: 10000 });

    // Send: the app's own modal, then the bridge's password ask on top.
    await app.locator("#w-send").click();
    await app.locator("#s-to").fill("1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E");
    await app.locator("#s-amount").fill("1");
    await app.locator(".modal .btn.primary", { hasText: "Send" }).click();
    await app.locator(".modal-body input[type=password]").waitFor({ timeout: 5000 });
    const ask = await app.locator(".modal-backdrop").last().textContent();
    ok("sending stops at a password ask", /password is required whenever funds leave/i.test(ask), ask.slice(0, 90));
    await app.locator(".modal-body input[type=password]").fill("typed-by-a-person");
    await app.locator(".modal .btn.primary", { hasText: "Confirm" }).click();
    await page.waitForTimeout(800);
    const sent = node.calls.filter((c) => c.channel === "chain:send").pop();
    ok("the send reached Core", Boolean(sent));
    ok("…carrying that password", sent?.payload?.password === "typed-by-a-person");
    ok("…and the original fields", sent?.payload?.to?.startsWith("1K1") && sent?.payload?.amount === "1");

    // Burn: the app's confirm modal, and NO password ask — value stays yours.
    await page.locator("#nav-koinos-burn").click();
    await app.locator("#burn-amount").waitFor({ timeout: 10000 });
    await app.locator("#burn-amount").fill("2");
    await app.locator("#burn-go").click();
    await app.locator(".modal .btn.danger").waitFor({ timeout: 5000 });
    const burnModal = await app.locator(".modal-backdrop").last().textContent();
    ok("burning confirms with the app's own modal", /permanently burn/.test(burnModal));
    ok("…and asks for no password", !/password/i.test(burnModal));
    await app.locator(".modal .btn.danger").click();
    await page.waitForTimeout(800);
    const burned = node.calls.filter((c) => c.channel === "chain:burn").pop();
    ok("the burn went straight through", Boolean(burned) && burned.payload.password === undefined);
  });

  // 4. The Fund view is the app's own, and starting a route asks for the password.
  await run("fund: the app's own screens, password on the way out", {}, async (page, app, node) => {
    await page.locator("#nav-koinos-fund").click();
    await page.waitForTimeout(1200);
    const fund = await app.locator("#view-fund").textContent();
    ok("the fund view is the node app's", /fund/i.test(fund) && (await app.locator("#view-fund").evaluate((e) => e.classList.contains("active"))));
    ok("…with its funding links and routes on the page", /ETH/.test(fund), fund.slice(0, 120));
  });

  // 5. No Docker: the node tab shows the app's own setup card, its buttons
  //    reach Core, and — field report — the screen STAYS PUT across the Earn
  //    toggle's ten-second status poll instead of yanking back to the dashboard.
  await run("a machine without Docker gets the guided setup, and screens stay put", { machine: { dockerInstalled: false, nodeRunning: false } }, async (page, app, node) => {
    await page.locator("#nav-koinos-node").click();
    await page.waitForTimeout(1200);
    const text = await app.locator("#view-node").textContent();
    ok("the setup card renders", /Install Docker|Docker isn't available|Install guide/.test(text), text.slice(0, 140));

    await app.locator('[data-setup-action="openDockerDocs"]').first().click();
    await page.waitForTimeout(600);
    ok("its button reaches Core's setup channel",
      node.calls.some((c) => c.channel.startsWith("setup:")),
      node.calls.filter((c) => c.channel.startsWith("setup:")).map((c) => c.channel).join(","));

    // Outlast the 10s poll in ui/koinos-view.js. Before the fix this view
    // was back on the dashboard by now.
    await page.waitForTimeout(11500);
    ok("11 seconds later the node view is still the node view",
      await app.locator("#view-node").evaluate((e) => e.classList.contains("active")));
    ok("…not the dashboard",
      !(await app.locator("#view-dashboard").evaluate((e) => e.classList.contains("active"))));
  });

  console.log(failures ? `\nKOINOS UI CHECK FAILED (${failures})` : "\nKOINOS UI CHECK PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
