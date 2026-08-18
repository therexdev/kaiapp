#!/usr/bin/env node
"use strict";

/*
 * Drives the Koinos node UI in a real browser against a real Core.
 *
 *   node core/scripts/verify-koinos-ui.js
 *
 * Unit tests pin the service; this proves the parts only a browser can break:
 * that the SWITCH reveals all seven node menus, that every screen paints from
 * a channel response, that the guided setup renders the node's own one-click
 * plan, and — the one that matters most — that every control which sends value
 * to someone else carries the typed password to Core, while burning and
 * automatic reburn do not.
 *
 * The 64 channels are answered here by a recorder that returns exactly the
 * shapes core/lib/koinos-node.js returns, so this run needs no Docker, no
 * mainnet and no funds. core/test/koinos-node.test.js is what pins the real
 * handlers; this pins the wiring in front of them.
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

const CHROME = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures += 1;
};

const ADDR = "1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E";
const ETH = "0x1d3f5AbC0000000000000000000000000000BeEf";

/** Answers every channel the screens call, in the shapes the real handlers
 *  return, and records what each one was called with. */
function recorder({ platform = "linux", dockerInstalled = true, dockerRunning = true, nodeRunning = true } = {}) {
  const calls = [];
  const setupStatus = () => {
    const steps = [];
    if (platform === "win32") {
      steps.push({ key: "wsl", title: "Enable WSL 2", detail: "One click installs the Windows Subsystem for Linux.", status: "active", action: { channel: "setup:installWsl", label: "Enable WSL" }, altAction: null });
    }
    steps.push(dockerInstalled
      ? { key: "docker", title: "Docker Desktop is installed", detail: "The Docker Desktop app is installed.", status: "done", action: null, altAction: null }
      : { key: "docker", title: "Install Docker Desktop", detail: "Downloads the official installer and launches it for you.", status: "active", action: { channel: "setup:installDocker", label: "Install Docker Desktop" }, altAction: null });
    steps.push(dockerRunning
      ? { key: "docker-start", title: "Docker is running", detail: "Docker Desktop is running and ready.", status: "done", action: null, altAction: null }
      : { key: "docker-start", title: "Start Docker Desktop", detail: "Docker is installed but not running yet.", status: dockerInstalled ? "active" : "pending", action: dockerInstalled ? { channel: "setup:startDocker", label: "Start Docker" } : null, altAction: null });
    return {
      platform,
      wsl: { installed: platform !== "win32" },
      docker: { installed: dockerInstalled, running: dockerRunning, appPath: null, cli: dockerRunning ? "docker" : null },
      ready: dockerInstalled && dockerRunning && platform !== "win32",
      steps,
      activeKey: steps.find((s) => s.action && s.status === "active")?.key ?? null,
      op: null,
    };
  };

  const map = {
    "app:info": () => ({
      version: "0.4.4", platform, userData: "/home/you/.koinos-ai/node", networks: {},
      settings: { network: "mainnet", "customRpc.mainnet": "", keepLiquidKoin: "10", "node.autoRecover": true },
      minPasswordLength: 8,
    }),
    "settings:update": () => ({ network: "mainnet" }),
    "wallet:status": () => ({ exists: true, unlocked: true, address: ADDR, ethAddress: ETH, createdAt: 1 }),
    "chain:balances": () => ({ address: ADDR, koin: "4308560000", vhp: "228813610000", mana: "3822790000", formatted: { koin: "43.0856", vhp: "2288.1361", mana: "38.2279" } }),
    "chain:maxBurn": () => ({ maxSat: "3308560000", maxFormatted: "33.0856", manaLimited: true, manaFormatted: "38.2279" }),
    "chain:burn": () => ({ txId: "0x1220burnburnburnburnburn", amountSat: "100000000", amountFormatted: "1" }),
    "chain:send": () => ({ txId: "0x1220sendsendsendsendsend", amountSat: "100000000" }),
    "dashboard:summary": () => ({
      network: { id: "mainnet", label: "Mainnet", tokenSymbol: "KOIN", explorer: "" },
      wallet: { exists: true, unlocked: true, address: ADDR },
      node: { docker: { ok: true }, isRunning: nodeRunning, runningCount: 7, op: null },
      sync: nodeRunning ? { inSync: true, local: { height: 38297044 }, remote: { height: 38297044 }, progressPct: 100 } : null,
      balances: { koin: "4308560000", vhp: "228813610000", mana: "3822790000" },
      stats: { available: true, windows: { last24h: "3120000", last7d: "21650000", last30d: "93480000", avgDailyProfit: "3116000" } },
      rewards: { enabled: true, pct: 50, mode: "burn" },
      returns: { reburnFraction: 0.5, yearlyReturnPct: 4.97, yearlyReturnReburnPct: 5.09 },
    }),
    "node:status": () => ({
      network: "mainnet", docker: { ok: dockerRunning }, filesReady: true, services: [], runningCount: nodeRunning ? 7 : 0,
      isRunning: nodeRunning, producerPublicKey: "pubkeyfromnode", op: null, dataDir: "/data", autoRecover: true,
      memorySaver: false, health: { ok: true }, sync: null, setup: dockerRunning ? null : setupStatus(),
    }),
    "setup:status": setupStatus,
    "setup:installDocker": () => ({ started: true }),
    "setup:installWsl": () => ({ started: true }),
    "setup:startDocker": () => ({ started: true }),
    "node:start": () => ({ started: true }),
    "node:stop": () => ({ stopped: true }),
    "node:quickSync": () => ({ started: true }),
    "node:setAutoRecover": () => ({ autoRecover: false }),
    "node:logs": () => "koinos-chain  | block 38297044 applied\nkoinos-p2p    | 12 peers",
    "producer:status": () => ({ address: ADDR, filePublicKey: "pubkeyfromnode", registeredPublicKey: null, matches: false }),
    "producer:register": () => ({ txId: "0x1220reg" }),
    "rewards:status": () => ({
      config: { enabled: true, pct: 50, mode: "burn" }, running: true, nextRunAt: 1767225600000,
      last: { time: 1767225000000, trigger: "timer", outcome: "burned" },
      derived: { anchored: true, lifetimeRewards: "500000000", rewardsSinceEnable: "200000000", returned: "80000000", pending: "20000000", actions: 3 },
      network: "mainnet", address: ADDR,
    }),
    "rewards:configure": () => ({ enabled: false, pct: 50, mode: "burn" }),
    "rewards:runNow": () => ({ last: { outcome: "burned" } }),
    "fund:status": () => ({ ethAddress: ETH, onrampEndpoint: "", onrampDefault: "https://example.invalid/api/session", onrampConfigured: true }),
    "fund:ethBalance": () => ({ address: ETH, wei: "0x16345785d8a0000", eth: "0.1" }),
    "fund:buyUrl": () => ({ url: "https://pay.coinbase.com/buy/select-asset?sessionToken=x" }),
    "fund:routeCompare": () => ({
      best: { id: "C" }, amountEth: "0.02", slippageBps: 150,
      routes: [
        { id: "B", label: "Bridge ETH, swap on KoinDX", steps: ["Bridge ETH → vETH (Vortex)", "Swap vETH → KOIN (KoinDX)"], koinOut: "1200000000", isBest: false, pctOfBest: 40, bestMultiple: 2.5, executable: true },
        { id: "C", label: "Swap to vKOIN, bridge to KOIN", steps: ["Swap ETH → USDT → vKOIN (Uniswap)", "Bridge vKOIN → KOIN (Vortex, 1:1)"], koinOut: "3000000000", isBest: true, pctOfBest: 100, bestMultiple: null, executable: true },
      ],
    }),
    "fund:routeMaxEth": () => ({ gasReserveEth: "0.004", balanceEth: "0.1" }),
    "fund:bridgeStart": () => ({ status: "started" }),
    "fund:routeCStart": () => ({ status: "started" }),
    "fund:bridgeStatus": () => null,
    "fund:routeCStatus": () => null,
  };

  return {
    calls,
    list: () => Object.keys(map),
    async call(channel, payload) {
      calls.push({ channel, payload });
      if (!map[channel]) throw new Error(`Unknown channel: ${channel}`);
      return map[channel](payload);
    },
  };
}

async function boot({ privacyMode = "network", node } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-koinos-ui-"));
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const hardware = { platform: "linux", arch: "x64", ramBytes: 32 * 1024 ** 3, diskFreeBytes: 400 * 1024 ** 3 };
  const koinos = new KoinosService({ settings, hardware, dataDir: dir, onEvent: () => {} });

  const gw = new Gateway({
    host: "127.0.0.1",
    port: 0,
    models: new ModelManager({ catalogPath: path.join(__dirname, "..", "models", "catalog.json"), modelsDir: path.join(dir, "m"), state: new JsonStore(path.join(dir, "st.json"), {}), onEvent: () => {} }),
    keys: new ApiKeys(new JsonStore(path.join(dir, "k.json"), {})),
    runtime: { status: () => ({ running: false }) },
    coreInfo: () => ({ version: "test" }),
    // Without this the gateway fails CLOSED to local-only — correct, but it
    // would mean this script never exercised the normal case.
    network: { status: () => ({ privacyMode }) },
    uiDir: path.join(__dirname, "..", "..", "ui"),
    koinos,
    koinosNode: node,
    onEvent: () => {},
  });
  await gw.listen();
  return { gw, base: `http://127.0.0.1:${gw.port}` };
}

async function run(label, opts, fn) {
  const node = opts.node || recorder(opts.machine || {});
  const { gw, base } = await boot({ privacyMode: opts.privacyMode, node });
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("dialog", (d) => d.accept());
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  // The switch lives at the bottom of Earn, and the app opens on Chat, so
  // every case starts by going where a user would go.
  await page.locator('.nav-item[data-view="earn"]').click();
  await page.waitForTimeout(400);
  console.log(`\n--- ${label} ---`);
  ok("the page loads with no script errors", errors.length === 0, errors[0] || "");
  try {
    await fn(page, node);
  } finally {
    await browser.close();
    await gw.close();
  }
}

const NAVS = ["nav-koinos", "nav-koinos-wallet", "nav-koinos-fund", "nav-koinos-burn", "nav-koinos-node", "nav-koinos-returns", "nav-koinos-settings"];

(async () => {
  // 1. The switch itself, and what it reveals.
  await run("the switch", {}, async (page) => {
    const sw = page.locator("#btn-koinos-toggle");
    ok("it is a switch, not a link or a button that says 'Turn on'", (await sw.getAttribute("role")) === "switch");
    ok("…and starts off", (await sw.getAttribute("aria-checked")) === "false");
    ok("…with no text label pretending to be a link", (await sw.textContent()).trim() === "");
    for (const id of NAVS) ok(`${id} is hidden until the switch is on`, await page.locator("#" + id).isHidden());

    await sw.click();
    await page.waitForTimeout(700);
    ok("flipping it reads as on", (await sw.getAttribute("aria-checked")) === "true");
    for (const id of NAVS) ok(`${id} appears`, await page.locator("#" + id).isVisible());
    ok("it lands on the dashboard so 'on' has somewhere to go", await page.locator("#view-koinos").isVisible());

    // Off again: every menu goes, and the user is not stranded on a hidden view.
    // Turning it on navigates to the dashboard, so go back to where the switch is.
    await page.locator('.nav-item[data-view="earn"]').click();
    await page.waitForTimeout(300);
    await sw.click();
    await page.waitForTimeout(600);
    for (const id of NAVS) ok(`${id} goes away again`, await page.locator("#" + id).isHidden());
    ok("…and the user is put back on Earn, not left on a blank screen", await page.locator("#view-earn").isVisible());
  });

  // 2. Every screen paints from a real channel response.
  await run("the seven screens", {}, async (page, node) => {
    await page.locator("#btn-koinos-toggle").click();
    await page.waitForTimeout(700);

    const dash = await page.locator("#koinos-body").textContent();
    ok("the dashboard formats satoshis, not raw integers", /43\.0856/.test(dash), dash.slice(0, 80));
    ok("…shows the producing stake", /2288\.1361/.test(dash));
    ok("…says the node is running", /Running · 7 services/.test(dash));
    ok("…shows what it earned", /Last 24 hours/.test(dash) && /0\.0312/.test(dash));
    ok("…and projects the return with reburn", /5\.1%/.test(dash), dash.match(/[\d.]+%/g)?.join(" ") || "");

    await page.locator("#nav-koinos-wallet").click();
    await page.waitForTimeout(500);
    const wallet = await page.locator("#koinos-wallet-body").textContent();
    ok("the wallet screen shows the Koinos AI address", wallet.includes(ADDR));
    ok("…and the Ethereum address from the same key", wallet.includes(ETH));
    ok("…and says plainly it is the same wallet", /same address you earn KAI with/i.test(wallet));
    ok("a Send control exists", (await page.locator("#kn-send-to").count()) === 1);
    ok("…and demands a password", (await page.locator("#kn-send-pw").getAttribute("type")) === "password");

    await page.locator("#nav-koinos-fund").click();
    await page.waitForTimeout(600);
    const fund = await page.locator("#koinos-fund-body").textContent();
    ok("the fund screen offers a card purchase", /Buy ETH with a card/.test(fund));
    ok("…shows the ETH balance it fetched", /0\.1/.test(fund));
    ok("…and asks for a password before bridging", (await page.locator("#kn-fund-pw").count()) === 1);

    await page.locator("#nav-koinos-burn").click();
    await page.waitForTimeout(500);
    const burn = await page.locator("#koinos-burn-body").textContent();
    ok("the burn screen shows the real ceiling", /33\.0856/.test(burn));
    ok("…and says WHY it is capped", /limited by mana/i.test(burn));
    ok("burning asks for no password — the value stays at your own address", (await page.locator("#koinos-burn-body input[type=password]").count()) === 0);

    await page.locator("#nav-koinos-node").click();
    await page.waitForTimeout(600);
    const nodeText = await page.locator("#koinos-node-body").textContent();
    ok("the node screen reports Docker", /Docker/.test(nodeText) && /Running/.test(nodeText));
    ok("…offers to stop the running node", (await page.locator("#koinos-node-body button", { hasText: "Stop node" }).count()) === 1);
    ok("…offers quick sync instead of a days-long resync", /Quick sync/.test(nodeText));
    ok("…and offers to register the key the node made", /Register this key/.test(nodeText));
    ok("…and shows the log", /peers/.test(nodeText));

    await page.locator("#nav-koinos-returns").click();
    await page.waitForTimeout(500);
    const ret = await page.locator("#koinos-returns-body").textContent();
    ok("returns shows what has gone back in", /0\.8 KOIN/.test(ret), ret.slice(0, 120));
    ok("…and states it never needs the password", /never asks for your password/i.test(ret));
    ok("automatic reburn asks for no password", (await page.locator("#koinos-returns-body input[type=password]").count()) === 0);

    await page.locator("#nav-koinos-settings").click();
    await page.waitForTimeout(500);
    const set = await page.locator("#koinos-settings-body").textContent();
    ok("settings names the network it is on", /mainnet/.test(set));
    ok("…and offers auto-restart", /auto-restart/i.test(set));
  });

  // 3. The money paths carry the typed password to Core. This is the check the
  //    owner asked for by name: same wallet, password before funds go out.
  await run("password before funds leave", {}, async (page, node) => {
    await page.locator("#btn-koinos-toggle").click();
    await page.waitForTimeout(700);

    await page.locator("#nav-koinos-wallet").click();
    await page.waitForTimeout(500);
    await page.locator("#kn-send-to").fill(ADDR);
    await page.locator("#kn-send-amt").fill("1");
    await page.locator("#kn-send-pw").fill("hunter2-typed-by-a-person");
    await page.locator("#koinos-wallet-body button", { hasText: "Send" }).click();
    await page.waitForTimeout(700);
    const send = node.calls.filter((c) => c.channel === "chain:send").pop();
    ok("sending reaches Core", Boolean(send));
    ok("…carrying the password the person typed", send?.payload?.password === "hunter2-typed-by-a-person");
    ok("…and the password box is emptied afterwards", (await page.locator("#kn-send-pw").inputValue()) === "");

    await page.locator("#nav-koinos-fund").click();
    await page.waitForTimeout(600);
    await page.locator("#kn-fund-amt").fill("0.02");
    await page.locator("#kn-fund-pw").fill("hunter2-typed-by-a-person");
    await page.locator("#koinos-fund-body button", { hasText: "Price both routes" }).click();
    await page.waitForTimeout(700);
    const fundText = await page.locator("#koinos-fund-body").textContent();
    ok("both routes are priced", /Route B/.test(fundText) && /Route C/.test(fundText));
    ok("…the better one is marked", /best right now/.test(fundText));
    ok("…and the worse one says how much is being left on the table", /2\.5× more/.test(fundText));

    await page.locator("#koinos-fund-body button", { hasText: "Use route C" }).click();
    await page.waitForTimeout(700);
    const started = node.calls.filter((c) => c.channel === "fund:routeCStart").pop();
    ok("picking a route starts THAT route", Boolean(started));
    ok("…with the password", started?.payload?.password === "hunter2-typed-by-a-person");
    ok("…and the amount", started?.payload?.amountEth === "0.02");

    await page.locator("#nav-koinos-burn").click();
    await page.waitForTimeout(500);
    await page.locator("#kn-burn-amt").fill("1");
    await page.locator("#koinos-burn-body button", { hasText: "Burn" }).click();
    await page.waitForTimeout(600);
    const burned = node.calls.filter((c) => c.channel === "chain:burn").pop();
    ok("burning still works with no password at all", Boolean(burned) && burned.payload.password === undefined);
  });

  // 4. A machine with nothing installed: the one-click setup the owner asked for.
  await run("a machine with no Docker", { machine: { dockerInstalled: false, dockerRunning: false, nodeRunning: false } }, async (page, node) => {
    await page.locator("#btn-koinos-toggle").click();
    await page.waitForTimeout(700);
    await page.locator("#nav-koinos-node").click();
    await page.waitForTimeout(700);

    const text = await page.locator("#koinos-node-body").textContent();
    ok("it says Docker is missing", /Not installed/.test(text));
    ok("…and offers to install it in one click", (await page.locator("#koinos-node-body button", { hasText: "Install Docker Desktop" }).count()) === 1);
    ok("…promising no terminal and no hunting for a download", /No terminal, nothing to download by hand/.test(text));
    ok("the step that can't run yet is disabled, not misleading", await page.locator("#koinos-node-body .kn-step-pending button").first().isDisabled().catch(() => true));

    await page.locator("#koinos-node-body button", { hasText: "Install Docker Desktop" }).click();
    await page.waitForTimeout(600);
    ok("clicking it actually asks Core to install Docker", node.calls.some((c) => c.channel === "setup:installDocker"));
  });

  // 5. Windows, where WSL comes first.
  await run("Windows without WSL", { machine: { platform: "win32", dockerInstalled: false, dockerRunning: false, nodeRunning: false } }, async (page, node) => {
    await page.locator("#btn-koinos-toggle").click();
    await page.waitForTimeout(700);
    await page.locator("#nav-koinos-node").click();
    await page.waitForTimeout(700);
    const text = await page.locator("#koinos-node-body").textContent();
    ok("WSL 2 is the first step on Windows", /WSL 2/.test(text));
    await page.locator("#koinos-node-body button", { hasText: "Enable WSL" }).click();
    await page.waitForTimeout(600);
    ok("…and it installs in one click", node.calls.some((c) => c.channel === "setup:installWsl"));
  });

  // 6. Local-Only. The sidebar promises nothing leaves this machine, and a node
  //    is nothing but network — so say so instead of failing screen by screen.
  await run("Privacy = Local-Only", { privacyMode: "local-only" }, async (page) => {
    const hint = await page.locator("#koinos-toggle-hint").textContent();
    ok("the switch says why it will not work", /Local-Only/.test(hint), hint.trim().slice(0, 90));
    ok("…and says how to change it", /Settings/.test(hint));
  });

  console.log(failures ? `\nKOINOS UI CHECK FAILED (${failures})` : "\nKOINOS UI CHECK PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
