"use strict";

const path = require("path");
const fs = require("fs");

const { JsonStore } = require("./store");
// From Koinos AI's own wallet — the one and only keystore in this app.
const { MIN_PASSWORD_LENGTH } = require("./wallet");
const { NETWORKS, DEFAULT_SETTINGS } = require("./koinos/constants");
const { ChainService } = require("./koinos/chain");
const { NodeManager } = require("./koinos/node-manager");
const { SetupService } = require("./koinos/setup");
const { RewardEngine } = require("./koinos/rewards");
const { ProducerStats } = require("./koinos/producer-stats");
const { projectReturns } = require("./koinos/profit-metrics");
const { parseAmount, formatAmount, subSats, cmpSats } = require("./koinos/format");
const { weiToEth } = require("./koinos/eth");
const { BridgeOrchestrator, MAX_BRIDGE_ETH } = require("./koinos/bridge-orchestrator");
const { RouteCOrchestrator, MAX_ROUTE_C_ETH } = require("./koinos/route-c-orchestrator");
const { quoteDeposit, maxBridgeable, makeProvider } = require("./koinos/eth-bridge");
const { quoteSend, maxSendable, sendEth } = require("./koinos/eth-send");
const { usdtBalance, quoteUsdtSend, maxUsdtSendable, sendUsdt } = require("./koinos/usdt-send");
const { vkoinBalance, quoteVkoinSend, maxVkoinSendable, sendVkoin } = require("./koinos/vkoin-send");
const { quoteSwap } = require("./koinos/koindx");
const { quoteEthToVkoin, quoteVkoinOut, applySlippage } = require("./koinos/eth-swap");
const { compareRoutes, descriptor } = require("./koinos/fund-routes");

/*
 * The Koinos node, inside Koinos AI. All of it.
 *
 * This is Koinos Node Desktop's entire capability set — running a real node
 * through Docker, guided WSL 2 / Docker Desktop setup, the wallet, burning,
 * producer registration, rewards and auto-reburn, producer stats, the Coinbase
 * onramp, the ETH bridge and the Route C swap path — brought over module for
 * module and driven from Core instead of from Electron IPC.
 *
 * WHAT CHANGED IN THE PORT, and nothing else did:
 *
 *   1. ONE WALLET. Koinos Node's own WalletService is NOT vendored. Everything
 *      here uses core/lib/wallet.js — the same keystore Koinos AI earns with,
 *      the same address, the same backup code. There is no second wallet.
 *
 *   2. THE PASSWORD GUARDS VALUE LEAVING. Sending KOIN, sending ETH/USDT/vKOIN,
 *      and starting a bridge or swap all prove the wallet password on the call.
 *      Reburn does not, and must not: it converts your KOIN into your own VHP at
 *      your own address, so nothing leaves, and it has to run unattended.
 *      Core re-opens the wallet at start-up from an OS-held secret, so being
 *      unlocked is never evidence that a person is at the keyboard.
 *
 *   3. Electron primitives (clipboard, shell.openExternal, shell.openPath) are
 *      not here — Core is headless. The renderer and the preload bridge own
 *      those, exactly as they already do for the rest of the app.
 *
 * Everything else — every docker compose call, the quick-sync tarball, the
 * mana cushion, the six-transaction Route C state machine — is the code that is
 * already tested and working in the other app.
 */

// The owner's existing onramp relay, shared with Koinos Node Desktop. The app
// key identifies the app to that endpoint; it is a client-side constant in
// both apps, so the endpoint's own caps are what actually bound abuse.
const DEFAULT_ONRAMP_ENDPOINT = "https://koinos-node.vercel.app/api/session";
const ONRAMP_APP_KEY = "kkapp_71854dc40591df1aeb8811a514e3dbc302bb382f";

function buildChannels({ settings, state, wallet, chain, nodeMgr, setup, rewards, stats, bridge, routeC, userData, appVersion, onEvent = () => {} }) {
  const channels = new Map();
  const handle = (channel, fn) => channels.set(channel, fn);

  /*
   * The wallet is the SAME wallet Koinos AI earns with, and core/server.js
   * re-opens it at start-up from a secret the OS holds. So it is nearly always
   * unlocked with nobody present, and "unlocked" proves nothing. Anything that
   * moves value to an address the user does not control proves the password on
   * that call. Reburn (KOIN -> your own VHP) deliberately does not.
   */
  const requirePassword = (password) => {
    wallet.signerFor(password); // throws on a missing or wrong password
    return true;
  };

  const publicNetworks = Object.fromEntries(
    Object.entries(NETWORKS).map(([id, n]) => [
      id,
      {
        id,
        label: n.label,
        tokenSymbol: n.tokenSymbol,
        explorer: n.explorer,
        contracts: n.contracts,
        ports: n.ports,
        rpcUrls: n.rpcUrls,
        localRpcUrl: n.localRpcUrl,
      },
    ])
  );

  // ----- app / settings -----
  handle("app:info", () => ({
    version: appVersion,
    platform: process.platform,
    userData,
    networks: publicNetworks,
    settings: settings.all(),
    minPasswordLength: MIN_PASSWORD_LENGTH,
  }));

  handle("settings:update", ({ network, customRpc, keepLiquidKoin, onrampEndpoint }) => {
    if (network !== undefined) {
      if (!NETWORKS[network]) throw new Error(`Unknown network: ${network}`);
      settings.set("network", network);
      chain.clearCache();
      rewards.start(); // re-arm timer; reward baselines are tracked per network
    }
    if (customRpc !== undefined) {
      for (const [netId, url] of Object.entries(customRpc)) {
        if (!NETWORKS[netId]) throw new Error(`Unknown network: ${netId}`);
        if (url && !/^https?:\/\/\S+$/.test(url)) throw new Error("RPC URL must start with http(s)://");
        settings.set(`customRpc.${netId}`, url || "");
      }
      chain.clearCache();
    }
    if (keepLiquidKoin !== undefined) {
      parseAmount(keepLiquidKoin);
      settings.set("keepLiquidKoin", String(keepLiquidKoin));
    }
    if (onrampEndpoint !== undefined) {
      const u = String(onrampEndpoint).trim();
      // Must be https — this endpoint holds the Coinbase secret key.
      if (u && !/^https:\/\/\S+$/.test(u)) throw new Error("Onramp endpoint must be an https:// URL");
      settings.set("onrampEndpoint", u);
    }
    return settings.all();
  });

  // ----- wallet -----
  handle("wallet:status", () => wallet.status());
  handle("wallet:create", ({ password }) => wallet.create({ password }));
  handle("wallet:import", ({ wif, password }) => wallet.importWif({ wif, password }));
  handle("wallet:unlock", ({ password }) => wallet.unlock(password));
  handle("wallet:lock", () => wallet.lock());
  handle("wallet:revealWif", ({ password }) => wallet.revealWif(password));
  handle("wallet:remove", ({ password, confirm }) => wallet.remove({ password, confirm }));

  // ----- chain -----
  handle("chain:balances", async () => {
    const address = wallet.address;
    if (!address) return { address: null };
    const b = await chain.balances(address);
    return {
      address,
      ...b,
      formatted: {
        koin: formatAmount(b.koin),
        vhp: formatAmount(b.vhp),
        mana: formatAmount(b.mana),
      },
    };
  });

  handle("chain:burn", async ({ amount }) => {
    const amountSat = parseAmount(amount);
    const res = await chain.burn(wallet.signer, amountSat);
    onEvent({
      type: "burn",
      message: `Burned ${formatAmount(amountSat)} ${chain.network().tokenSymbol} → VHP`,
      txId: res.txId,
    });
    return { ...res, amountSat, amountFormatted: formatAmount(amountSat) };
  });

  handle("chain:send", async ({ to, amount, token, password }) => {
    const amountSat = parseAmount(amount);
    // Sending moves value to somebody else: the password is proved HERE,
    // on this call, because the wallet auto-unlocks at start-up and being
    // unlocked is not evidence a person is present.
    const res = await chain.transfer(wallet.signerFor(password), { to, amountSat, token });
    onEvent({
      type: "send",
      message: `Sent ${formatAmount(amountSat)} ${String(token).toUpperCase()} to ${to}`,
      txId: res.txId,
    });
    return { ...res, amountSat };
  });

  handle("chain:sync", () => chain.syncStatus());

  handle("chain:maxBurn", async () => {
    const address = wallet.address;
    if (!address) throw new Error("No wallet");
    const { koin, mana } = await chain.balances(address);
    const keep = parseAmount(settings.get("keepLiquidKoin", "10"));
    // Cap by liquid balance above the mana buffer AND by mana actually available
    // now — burning requires mana >= amount, so a balance-only Max can suggest an
    // amount that reverts with "could not burn KOIN".
    const byBalance = cmpSats(koin, keep) > 0 ? subSats(koin, keep) : "0";
    const byMana = chain.burnableFromMana(mana);
    const manaLimited = cmpSats(byMana, byBalance) < 0;
    const max = manaLimited ? byMana : byBalance;
    return {
      maxSat: max,
      maxFormatted: formatAmount(max, { grouping: false }),
      manaLimited,
      manaFormatted: formatAmount(mana),
    };
  });

  // ----- block producer registration -----
  handle("producer:status", async () => {
    const networkId = chain.network().id;
    const address = wallet.address;
    const filePublicKey = nodeMgr.readProducerPublicKey(networkId);
    let registeredPublicKey = null;
    if (address) {
      registeredPublicKey = await chain.registeredPublicKey(address);
    }
    return {
      address,
      filePublicKey,
      registeredPublicKey,
      matches: !!filePublicKey && filePublicKey === registeredPublicKey,
    };
  });

  handle("producer:register", async () => {
    const networkId = chain.network().id;
    const pub = nodeMgr.readProducerPublicKey(networkId);
    if (!pub) {
      throw new Error(
        "No signing key found yet. Start the node once — the block producer generates its key on first run."
      );
    }
    const res = await chain.registerProducerKey(wallet.signer, pub);
    onEvent({ type: "producer", message: "Block production key registered on chain", txId: res.txId });
    return res;
  });

  // ----- node -----
  handle("node:status", async () => {
    const networkId = chain.network().id;
    const status = await nodeMgr.status(networkId);
    let sync = null;
    if (status.isRunning) {
      sync = await chain.syncStatus().catch(() => null);
    }
    // Only probe prerequisites while Docker isn't usable yet — this is what
    // drives the guided setup card.
    let setupStatus = null;
    if (!status.docker?.ok) {
      setupStatus = await setup.status().catch(() => null);
    }
    return { network: networkId, ...status, sync, setup: setupStatus };
  });

  // ----- guided setup (WSL + Docker) -----
  handle("setup:status", () => setup.status());
  handle("setup:installWsl", () => setup.installWsl());
  handle("setup:restart", () => setup.restart());
  handle("setup:cancelRestart", () => setup.cancelRestart());
  handle("setup:installDocker", () => setup.installDocker());
  handle("setup:cancelInstallDocker", () => setup.cancelInstallDocker());
  handle("setup:startDocker", () => setup.startDocker());
  handle("setup:markWslReady", () => setup.markWslReady());
  handle("setup:openDockerDocs", () => {
    shell.openExternal(setup.dockerDocsUrl());
    return true;
  });

  handle("node:start", async ({ produce }) => {
    const networkId = chain.network().id;
    // One-time, best-effort: right-size the WSL VM so the node has enough memory
    // to begin with. Self-skips off Windows; writes .wslconfig only when it would
    // raise a too-low limit. Fully guarded — tuning must NEVER block starting the
    // node, whatever goes wrong here.
    try {
      if (!state.get("node.memoryTuned", false)) {
        await setup.optimizeWslMemory().catch(() => {});
        state.set("node.memoryTuned", true);
      }
    } catch {
      /* tuning is best-effort; starting the node always wins */
    }
    let producerAddress = null;
    if (produce) {
      producerAddress = wallet.address;
      if (!producerAddress) throw new Error("Create a wallet first to enable block production");
    }
    return nodeMgr.start(networkId, producerAddress);
  });

  handle("node:stop", () => nodeMgr.stop(chain.network().id));
  handle("node:setAutoRecover", ({ on }) => {
    settings.set("node.autoRecover", !!on);
    nodeMgr.setAutoRecover(!!on);
    return { autoRecover: !!on };
  });
  handle("node:logs", ({ service, tail }) => nodeMgr.logs(chain.network().id, service, tail));
  handle("node:quickSyncInfo", () => nodeMgr.quickSyncInfo(chain.network().id));
  handle("node:quickSync", () => nodeMgr.quickSync(chain.network().id));
  handle("node:quickSyncCancel", () => nodeMgr.cancelQuickSync());

  // ----- dashboard -----
  handle("dashboard:summary", async () => {
    const net = chain.network();
    const address = wallet.address;
    const ws = wallet.status();
    const out = {
      network: { id: net.id, label: net.label, tokenSymbol: net.tokenSymbol, explorer: net.explorer },
      wallet: { exists: ws.exists, unlocked: ws.unlocked, address },
      node: null,
      balances: null,
      stats: null,
      rewards: rewards.status().config,
    };
    // Node running state (docker + services).
    try {
      const ns = await nodeMgr.status(net.id);
      out.node = {
        docker: ns.docker,
        isRunning: ns.isRunning,
        runningCount: ns.runningCount,
        op: ns.op,
        producerRegistered: null,
      };
      if (ns.isRunning) {
        out.sync = await chain.syncStatus().catch(() => null);
      }
    } catch (e) {
      out.node = { error: String(e.message) };
    }
    if (!address) return out;
    // Balances + producer stats (both hit the RPC).
    const [balances, statsRes] = await Promise.all([
      chain.balances(address).catch((e) => ({ error: String(e.message) })),
      stats.refresh(address).catch((e) => ({ available: false, error: String(e.message) })),
    ]);
    out.balances = balances;
    out.stats = statsRes;

    // Projected returns: annualize the recent daily profit rate against the
    // producing stake (VHP), plus a compounded figure at the user's reburn rate.
    const rcfg = out.rewards || {};
    const reburnFraction = rcfg.enabled && rcfg.mode === "burn" ? Number(rcfg.pct || 0) / 100 : 0;
    const windows = statsRes && statsRes.windows ? statsRes.windows : null;
    const stakeSats = balances && !balances.error ? balances.vhp : "0";
    out.returns = windows
      ? projectReturns({ avgDailyProfitSats: windows.avgDailyProfit, stakeSats, reburnFraction })
      : null;

    // Screenshot/demo-only override (never set in production): present a
    // running, synced node with representative balances so marketing shots
    // show a live dashboard.
    if (process.env.KND_DEMO) {
      out.node = { docker: { ok: true }, isRunning: true, runningCount: 7, op: null };
      out.sync = {
        inSync: true,
        local: { height: 38297044, headBlockTimeMs: Date.now(), error: null },
        remote: { height: 38297044 },
        progressPct: 100,
      };
      out.balances = { koin: "4308560000", vhp: "228813610000", mana: "3822790000" };
      const demoWindows = { last24h: "31200000", last7d: "216500000", last30d: "934800000", avgDailyProfit: "31160000", daysTracked: 30 };
      out.stats = { available: true, network: net.id, totals: out.stats?.totals ?? null, feed: out.stats?.feed ?? [], windows: demoWindows, syncing: false };
      out.returns = projectReturns({ avgDailyProfitSats: demoWindows.avgDailyProfit, stakeSats: out.balances.vhp, reburnFraction: 0.5 });
    }
    return out;
  });

  // ----- rewards -----
  handle("rewards:status", () => rewards.status());
  handle("rewards:configure", (patch) => rewards.configure(patch));
  handle("rewards:runNow", () => rewards.tick("manual"));

  // ----- fund node (Ethereum on-ramp — Phase 1) -----
  // Shared, app-hosted Coinbase Onramp endpoint. Every install uses this by
  // default so the Buy button works with zero setup; advanced users can override
  // it with their own endpoint in the Fund tab. (DEFAULT_ONRAMP_ENDPOINT and
  // ONRAMP_APP_KEY are defined at module scope.)
  const effectiveOnrampEndpoint = () => settings.get("onrampEndpoint", "") || DEFAULT_ONRAMP_ENDPOINT;

  handle("fund:status", () => ({
    ethAddress: wallet.ethAddress,
    onrampEndpoint: settings.get("onrampEndpoint", ""), // user override; blank = built-in default
    onrampDefault: DEFAULT_ONRAMP_ENDPOINT,
    onrampConfigured: !!effectiveOnrampEndpoint(),
  }));

  // Asks the user's own Coinbase Onramp endpoint (a small serverless function
  // holding their CDP secret) to mint a session token for the wallet's ETH
  // address, then builds the hosted Coinbase Pay URL. Post-2025 Onramp requires
  // this server-minted session token — the secret never lives in the app.
  handle("fund:buyUrl", async ({ amountUsd } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first to get a funding address.");
    const endpoint = effectiveOnrampEndpoint();
    if (!endpoint) throw new Error("No Coinbase Onramp endpoint is configured.");
    let token;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-koinoskit-app": ONRAMP_APP_KEY },
        body: JSON.stringify({ address, asset: "ETH", network: "ethereum" }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!resp.ok) throw new Error(`endpoint returned HTTP ${resp.status}`);
      const data = await resp.json();
      token = data.token || data.sessionToken;
    } catch (e) {
      throw new Error(`Couldn't reach your Onramp endpoint: ${String(e.message || e)}`);
    }
    if (!token) throw new Error("Your Onramp endpoint didn't return a session token.");
    const u = new URL("https://pay.coinbase.com/buy/select-asset");
    u.searchParams.set("sessionToken", token);
    u.searchParams.set("defaultAsset", "ETH");
    u.searchParams.set("defaultNetwork", "ethereum");
    u.searchParams.set("fiatCurrency", "USD");
    if (amountUsd && Number(amountUsd) > 0) u.searchParams.set("presetFiatAmount", String(Number(amountUsd)));
    return { url: u.toString() };
  });

  // Read-only ETH balance of the wallet's funding address, via public RPCs
  // (tried in order). Lets the user confirm funds arrived before bridging.
  const ETH_RPCS = [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://rpc.ankr.com/eth",
  ];
  handle("fund:ethBalance", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    let lastErr;
    for (const rpc of ETH_RPCS) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const resp = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.error) throw new Error(data.error.message || "RPC error");
        return { address, wei: data.result, eth: weiToEth(data.result) };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Couldn't fetch ETH balance: ${String(lastErr?.message || lastErr)}`);
  });

  // ----- fund node bridge (Phase 2: ETH -> vETH -> KOIN) -----
  handle("fund:bridgeStatus", () => bridge.status());
  handle("fund:bridgeReset", () => bridge.reset());
  handle("fund:bridgeAdvance", () => bridge.advance());
  handle("fund:bridgeStart", ({ amountEth, slippageBps, password } = {}) => {
    // Starting a bridge authorises the WHOLE flow: the advancer then signs its
    // remaining steps unattended. So the password is proved at the intent,
    // once, rather than per signature.
    requirePassword(password);
    return bridge.start({ amountEth, slippageBps });
  });

  // Route C (ETH → USDT → vKOIN → bridge → native KOIN). start() sets up + quotes;
  // advance() is called once here to send the first tx, then the 8s driver takes over.
  handle("fund:routeCStatus", () => routeC.status());
  handle("fund:routeCReset", () => routeC.reset());
  handle("fund:routeCAdvance", () => routeC.advance());
  handle("fund:routeCResume", () => routeC.resume());
  handle("fund:routeCStart", async ({ amountEth, amountUsdt, amountVkoin, source, slippageBps, password } = {}) => {
    requirePassword(password); // same intent-level authorisation as the bridge
    const job = await routeC.start({ amountEth, amountUsdt, amountVkoin, source, slippageBps });
    routeC.advance().catch(() => {}); // kick the first Ethereum tx immediately
    return job;
  });
  handle("fund:bridgeMax", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxBridgeable({
      fromAddress: address,
      koinosRecipient: wallet.address,
      network: settings.get("network", "mainnet"),
      capEth: MAX_BRIDGE_ETH,
    });
  });
  handle("fund:bridgeQuote", async ({ amountEth, slippageBps } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const network = settings.get("network", "mainnet");
    const deposit = await quoteDeposit({ fromAddress: address, amountEth, koinosRecipient: wallet.address, network });
    let swap = null;
    try {
      swap = await quoteSwap({ amountInSats: deposit.vethSats, slippageBps: slippageBps || 150, network, provider: chain.provider() });
    } catch (e) {
      swap = { error: String(e.message || e) };
    }
    return { deposit, swap, maxEth: MAX_BRIDGE_ETH };
  });

  // Compare both funding routes for a given ETH amount and rank by KOIN out, so
  // the UI can show the best plus the runners-up. Read-only (quotes only).
  //   Route B: ETH → vETH (Vortex) → KOIN (KoinDX)
  //   Route C: ETH → USDT → vKOIN (Uniswap v4) → KOIN (Vortex, 1:1)
  // Route C is quote-only in this build (execution ships next); `executable`
  // tells the UI which route the Bridge button can actually run today.
  handle("fund:routeCompare", async ({ amountEth, slippageBps = 150 } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const network = settings.get("network", "mainnet");

    let routeB;
    try {
      const deposit = await quoteDeposit({ fromAddress: address, amountEth, koinosRecipient: wallet.address, network });
      const swap = await quoteSwap({ amountInSats: deposit.vethSats, slippageBps, network, provider: chain.provider() });
      routeB = { ...descriptor("B"), executable: true, koinOut: swap.amountOut, koinOutMin: swap.amountOutMin, gasCostEth: deposit.gasCostEth };
    } catch (e) {
      routeB = { ...descriptor("B"), executable: true, koinOut: null, error: String(e.message || e) };
    }

    let routeC;
    try {
      const q = await quoteEthToVkoin({ amountEth, slippageBps });
      routeC = { ...descriptor("C"), executable: true, koinOut: q.koinOut, koinOutMin: q.koinOutMin, usdtOut: q.usdtOut };
    } catch (e) {
      routeC = { ...descriptor("C"), executable: true, koinOut: null, error: String(e.message || e) };
    }

    return { ...compareRoutes([routeB, routeC]), amountEth: String(amountEth), slippageBps };
  });

  // ----- withdraw ETH out (so ETH parked for bridging isn't trapped) -----
  handle("fund:ethSendQuote", async ({ toAddress, amountEth } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return quoteSend({ fromAddress: address, toAddress, amountEth });
  });
  handle("fund:ethSendMax", async ({ toAddress } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxSendable({ fromAddress: address, toAddress });
  });
  // REAL ETH MOVES HERE. ethPrivateKey() throws if the wallet is locked, so the
  // send is gated on an unlocked wallet.
  handle("fund:ethSend", async ({ toAddress, amountEth, password } = {}) => {
    if (!wallet.ethAddress) throw new Error("Create or unlock your wallet first.");
    requirePassword(password); // ETH leaving for another address
    const res = await sendEth({ ethPrivHex: wallet.ethPrivateKey(), toAddress, amountEth });
    return res;
  });

  // ----- ETH + USDT balances (one round-trip) for the Wallet tab -----
  handle("fund:cryptoBalances", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const provider = await makeProvider();
    const [ethWei, usdt, vkoin] = await Promise.all([
      provider.getBalance(address),
      usdtBalance({ address, provider }),
      vkoinBalance({ address, provider }),
    ]);
    return {
      address,
      ethWei: ethWei.toString(),
      eth: weiToEth("0x" + ethWei.toString(16)),
      usdtSats: usdt.sats,
      usdt: usdt.usdt,
      vkoinSats: vkoin.sats,
      vkoin: vkoin.vkoin,
    };
  });

  // ----- withdraw / send USDT out -----
  handle("fund:usdtSendQuote", async ({ toAddress, amountUsdt } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return quoteUsdtSend({ fromAddress: address, toAddress, amountUsdt });
  });
  handle("fund:usdtSendMax", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxUsdtSendable({ fromAddress: address });
  });
  // REAL USDT MOVES HERE. Gated on an unlocked wallet (ethPrivateKey throws locked).
  handle("fund:usdtSend", async ({ toAddress, amountUsdt, password } = {}) => {
    if (!wallet.ethAddress) throw new Error("Create or unlock your wallet first.");
    requirePassword(password);
    return sendUsdt({ ethPrivHex: wallet.ethPrivateKey(), toAddress, amountUsdt });
  });

  // ----- quote KOIN out for funding the node directly from USDT (Route C) -----
  handle("fund:usdtFundQuote", async ({ amountUsdt, slippageBps = 150 } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const provider = await makeProvider();
    const usdtSats = require("./lib/usdt-send").parseUsdt(amountUsdt);
    if (usdtSats <= 0n) throw new Error("Amount must be greater than 0");
    const koin = await quoteVkoinOut({ usdtSats, provider });
    return { amountUsdt: String(amountUsdt), koinOut: koin.toString(), koinOutMin: applySlippage(koin, slippageBps).toString(), slippageBps };
  });

  // ----- send vKOIN out / bridge-to-KOIN recovery -----
  handle("fund:vkoinSendQuote", async ({ toAddress, amountVkoin } = {}) => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return quoteVkoinSend({ fromAddress: address, toAddress, amountVkoin });
  });
  handle("fund:vkoinSendMax", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    return maxVkoinSendable({ fromAddress: address });
  });
  handle("fund:vkoinSend", async ({ toAddress, amountVkoin, password } = {}) => {
    if (!wallet.ethAddress) throw new Error("Create or unlock your wallet first.");
    requirePassword(password);
    return sendVkoin({ ethPrivHex: wallet.ethPrivateKey(), toAddress, amountVkoin });
  });

  // ----- gas-aware Max for ETH funding: balance minus a Route-C gas reserve -----
  // Route C sends up to ~6 txs (swaps + approvals + bridge); reserve enough ETH so
  // the run can't stall out of gas mid-flow, and flag if the balance can't cover it.
  handle("fund:routeMaxEth", async () => {
    const address = wallet.ethAddress;
    if (!address) throw new Error("Create or unlock your wallet first.");
    const provider = await makeProvider();
    const balance = await provider.getBalance(address);
    const fee = await provider.getFeeData();
    const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    const ROUTE_C_GAS = 750000n; // ETH→USDT + 2 approvals + USDT→vKOIN + approve + bridge
    const gasReserve = (perGas * ROUTE_C_GAS * 13n) / 10n; // +30% headroom
    let maxWei = balance > gasReserve ? balance - gasReserve : 0n;
    const capWei = 50000000000000000n; // 0.05 ETH
    if (maxWei > capWei) maxWei = capWei;
    return {
      maxWei: maxWei.toString(),
      maxEth: weiToEth("0x" + maxWei.toString(16)),
      gasReserveEth: weiToEth("0x" + gasReserve.toString(16)),
      balanceEth: weiToEth("0x" + balance.toString(16)),
      enoughForGas: balance > gasReserve,
    };
  });

  // ----- utilities -----



  return channels;
}



/**
 * Construct the whole node stack against Koinos AI's own wallet and data dir,
 * and return { channels, stop } where channels is the full name -> handler map.
 * Nothing here starts a node or touches the network on its own; the advancer
 * timers only do work once the user has started a flow.
 */
function createKoinosNode({ dataDir, wallet, appVersion, onEvent = () => {} }) {
  const root = path.join(dataDir, "koinos-node");
  fs.mkdirSync(root, { recursive: true });

  const settings = new JsonStore(path.join(root, "settings.json"), DEFAULT_SETTINGS);
  const state = new JsonStore(path.join(root, "state.json"), {});
  const chain = new ChainService(settings);

  const nodeMgr = new NodeManager({
    templateRoot: path.join(__dirname, "..", "koinos-node-template"),
    dataRoot: path.join(root, "node"),
    onEvent,
    autoRecover: settings.get("node.autoRecover", true),
    probeHead: async () => {
      const s = await chain.syncStatus().catch(() => null);
      const h = s?.local?.height;
      return h != null ? Number(h) : null;
    },
  });

  const setup = new SetupService({
    platform: process.platform,
    arch: process.arch,
    downloadDir: path.join(root, "downloads"),
    state,
    onEvent,
  });

  const stats = new ProducerStats({ chain, state });
  const rewards = new RewardEngine({ chain, wallet, settings, state, stats, onEvent });
  rewards.start(); // auto-reburn; signs with the unlocked wallet, sends nothing away

  const bridge = new BridgeOrchestrator({
    wallet,
    provider: chain.provider(),
    store: new JsonStore(path.join(root, "fund-bridge.json"), { job: null }),
    settings,
    appKey: ONRAMP_APP_KEY,
    network: settings.get("network", "mainnet"),
    onEvent,
  });
  const routeC = new RouteCOrchestrator({
    wallet,
    provider: chain.provider(),
    store: new JsonStore(path.join(root, "fund-routec.json"), { routeCJob: null }),
    settings,
    appKey: ONRAMP_APP_KEY,
    network: settings.get("network", "mainnet"),
    onEvent,
  });

  // Advancers. A bridge or swap the user STARTED (and proved the password for)
  // finishes on its own; these only ever act on a job already in flight.
  const bridgeTimer = setInterval(() => {
    const job = bridge.status();
    if (job && !["done", "error", "depositing"].includes(job.status)) bridge.advance().catch(() => {});
  }, 15000);
  const routeCTimer = setInterval(() => {
    const job = routeC.status();
    if (job && !["done", "error"].includes(job.status) && wallet.status().unlocked) {
      routeC.advance().catch(() => {});
    }
  }, 8000);
  bridgeTimer.unref?.();
  routeCTimer.unref?.();

  const channels = buildChannels({
    settings, state, wallet, chain, nodeMgr, setup, rewards, stats, bridge, routeC,
    userData: root, appVersion,
  });

  return {
    channels,
    settings,
    nodeMgr,
    async call(channel, payload) {
      const fn = channels.get(String(channel));
      if (!fn) throw new Error(`Unknown Koinos channel: ${channel}`);
      return fn(payload ?? {});
    },
    list() {
      return [...channels.keys()].sort();
    },
    stop() {
      clearInterval(bridgeTimer);
      clearInterval(routeCTimer);
      try { rewards.stop(); } catch { /* already stopped */ }
    },
  };
}

module.exports = { createKoinosNode, buildChannels, ONRAMP_APP_KEY };
