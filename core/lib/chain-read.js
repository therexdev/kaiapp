"use strict";

const { Provider, Contract, utils } = require("koilib");
const { NETWORKS, SATS_PER_KOIN } = require("./chain-constants");
const POB_ABI = require("./abi/pob-abi.json");
const TOKEN_ABI = require("./abi/token-abi.json");

/*
 * Read-only Koinos chain client.
 *
 * An ADAPTED FORK of electron/lib/chain.js in therexdev/koinos-node (local
 * checkout: /workspace/therexdev/koinos-node/electron/lib/chain.js). Adapted,
 * not copied: a different koilib minor, no signer parameter anywhere, and
 * roughly half the methods removed. No checksum test can cover that, so if you
 * are changing this, read the counterpart first — and if you fix a bug here
 * that exists there too, fix it there.
 *
 * DELIBERATELY ABSENT, and not an oversight:
 *   · burn, transfer, registerProducerKey — every method that signs.
 *   · any `signer` parameter. The upstream _contract() does
 *     `if (signer) signer.provider = p`, which MUTATES the signer it is
 *     handed. In Koinos AI that object is core/lib/wallet.js's `get signer()`
 *     singleton — the very one core/lib/worker.js signs earn receipts with.
 *     This client constructs its own Provider and never touches it.
 *
 * Everything here is a read. The worst it can do is show a wrong number.
 */

const CONTRACT_NAMES = ["koin", "vhp", "pob"];
const RESOLVE_TTL_MS = 60 * 60 * 1000;
const RPC_TIMEOUT_MS = 12000;

/** koilib surfaces raw JSON-RPC payloads as message strings; dig out the part
 *  a person can act on. */
function rpcError(e) {
  let msg = String(e?.message ?? e ?? "Could not reach the Koinos network");
  try {
    const parsed = JSON.parse(msg);
    if (typeof parsed?.error === "string") {
      msg = parsed.error;
      if (Array.isArray(parsed.logs) && parsed.logs.length) msg += ` — ${parsed.logs[0]}`;
    } else {
      msg = parsed?.error?.message ?? parsed?.message ?? msg;
    }
  } catch {
    /* not JSON — the string is already the message */
  }
  return new Error(msg);
}

/** Satoshis (bigint or numeric string) → a human amount, no float rounding. */
function formatKoin(sats, decimals = 4) {
  let v;
  try {
    v = BigInt(String(sats ?? "0"));
  } catch {
    return "0";
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = v / SATS_PER_KOIN;
  const frac = (v % SATS_PER_KOIN).toString().padStart(8, "0").slice(0, decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

class ChainRead {
  /** settings: anything with get(key, fallback) — core/lib/store.js JsonStore
   *  satisfies it, which is why no adapter is needed. */
  constructor(settings) {
    this.settings = settings;
    this._resolved = {}; // networkId -> { addrs, at }
  }

  network() {
    return NETWORKS[this.settings.get("koinos.network", "mainnet")] ?? NETWORKS.mainnet;
  }

  /** A node the user pointed us at wins over the public RPC — that is the
   *  whole value of running one. */
  rpcUrls() {
    const custom = String(this.settings.get("koinos.rpcUrl", "") || "").trim();
    if (/^https?:\/\//.test(custom)) return [custom];
    return this.network().rpcUrls;
  }

  provider(urls) {
    return new Provider(urls ?? this.rpcUrls());
  }

  isValidAddress(address) {
    try {
      return utils.isChecksumAddress(String(address ?? "").trim());
    } catch {
      return false;
    }
  }

  clearCache() {
    this._resolved = {};
  }

  /** KOIN and VHP have migrated on mainnet before, so ask the chain rather
   *  than trusting the vendored addresses. Falls back to them per-contract. */
  async resolveContracts(provider) {
    const net = this.network();
    const cached = this._resolved[net.id];
    if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.addrs;
    const p = provider ?? this.provider();
    const addrs = { ...net.contracts };
    const drifted = [];
    await Promise.all(
      CONTRACT_NAMES.map(async (name) => {
        try {
          const r = await p.invokeGetContractAddress(name);
          const a = r?.value?.address;
          if (a && this.isValidAddress(a)) {
            if (a !== addrs[name]) drifted.push(`${name}: vendored ${addrs[name]} → chain ${a}`);
            addrs[name] = a;
          }
        } catch {
          /* keep the fallback — a resolve failure must not blank the screen */
        }
      })
    );
    // The one thing that would silently show wrong numbers forever: our
    // vendored copy going stale. Say so once per resolve rather than never.
    if (drifted.length) this._onDrift?.(drifted);
    this._resolved[net.id] = { addrs, at: Date.now() };
    return addrs;
  }

  async _contract(kind, provider) {
    const addrs = await this.resolveContracts(provider);
    return new Contract({
      id: addrs[kind],
      abi: kind === "pob" ? POB_ABI : TOKEN_ABI,
      provider,
    });
  }

  /** KOIN, VHP and mana for any address. Mana matters on its own: it is what
   *  a send or a burn actually spends, and it refills over ~5 days. */
  async balances(address) {
    if (!this.isValidAddress(address)) throw new Error("That is not a valid Koinos address");
    const provider = this.provider();
    try {
      const [koin, vhp] = await Promise.all([this._contract("koin", provider), this._contract("vhp", provider)]);
      const [k, v, rc] = await Promise.all([
        koin.functions.balance_of({ owner: address }),
        vhp.functions.balance_of({ owner: address }),
        provider.getAccountRc(address).catch(() => "0"),
      ]);
      const sats = {
        koin: String(k?.result?.value ?? "0"),
        vhp: String(v?.result?.value ?? "0"),
        mana: String(rc ?? "0"),
      };
      return {
        address,
        sats,
        koin: formatKoin(sats.koin),
        vhp: formatKoin(sats.vhp),
        mana: formatKoin(sats.mana),
      };
    } catch (e) {
      throw rpcError(e);
    }
  }

  /** Head block of whichever RPC we are pointed at. Used to tell "your node is
   *  running" apart from "your node is running but is 40,000 blocks behind". */
  async headInfo(urls) {
    const provider = this.provider(urls);
    try {
      const info = await provider.getHeadInfo();
      return {
        height: Number(info?.head_topology?.height ?? 0),
        lastIrreversible: Number(info?.last_irreversible_block ?? 0),
        headBlockTime: Number(info?.head_block_time ?? 0),
      };
    } catch (e) {
      throw rpcError(e);
    }
  }

  /** Is a node answering at this URL, and how far behind is it? Never throws:
   *  "not connected" is an ordinary answer here, not an error. */
  async probeNode(url, publicHead = null) {
    const target = String(url ?? "").trim();
    if (!/^https?:\/\//.test(target)) return { connected: false, reason: "no-url" };
    try {
      const head = await Promise.race([
        this.headInfo([target]),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), RPC_TIMEOUT_MS)),
      ]);
      const behind = publicHead && publicHead > head.height ? publicHead - head.height : 0;
      return { connected: true, height: head.height, behind, synced: behind <= 5 };
    } catch (e) {
      return { connected: false, reason: "unreachable", detail: String(e.message).slice(0, 160) };
    }
  }

  /** The block-production key registered to an address, if any. Read-only —
   *  registering one is a signing operation and lives nowhere in this file. */
  async registeredPublicKey(producer) {
    if (!this.isValidAddress(producer)) throw new Error("That is not a valid Koinos address");
    const provider = this.provider();
    try {
      const pob = await this._contract("pob", provider);
      const r = await pob.functions.get_public_key({ producer });
      return r?.result?.value ?? null;
    } catch (e) {
      throw rpcError(e);
    }
  }
}

module.exports = { ChainRead, formatKoin, rpcError };
