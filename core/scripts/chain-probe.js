#!/usr/bin/env node
"use strict";

/*
 * Probes Koinos RPC candidates from a machine with real egress (the CI
 * runner), because the dev sandbox's proxy can't reach them. Prints each
 * endpoint's chain id and head height — the facts lib/chain.js presets in
 * the kai repo must be pinned to — plus whether tradekoinos.com (the DEX the
 * owner wants to rehearse the listing on) answers.
 *
 * Read-only everywhere. No keys, no transactions.
 */

const CANDIDATES = [
  // The dead one production is configured against today, for the record:
  { name: "foundation-testnet", url: "https://testnet.koinosfoundation.org/jsonrpc" },
  // Harbinger (the current Koinos testnet), most likely public doors:
  { name: "harbinger-api", url: "https://harbinger-api.koinos.io" },
  { name: "harbinger-api/jsonrpc", url: "https://harbinger-api.koinos.io/jsonrpc" },
  // Mainnet control (known good — proves the probe itself works):
  { name: "mainnet", url: "https://api.koinos.io" },
];

async function rpc(url, method, params = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return j.error ? { error: JSON.stringify(j.error).slice(0, 120) } : { result: j.result };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 120) };
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  let live = 0;
  for (const c of CANDIDATES) {
    const [head, chain] = await Promise.all([
      rpc(c.url, "chain.get_head_info"),
      rpc(c.url, "chain.get_chain_id"),
    ]);
    if (head.result && chain.result) {
      live += 1;
      console.log(`RPC LIVE  ${c.name} ${c.url}`);
      console.log(`   chain_id=${chain.result.chain_id}`);
      console.log(`   head=${head.result.head_topology?.height} lib=${head.result.last_irreversible_block}`);
    } else {
      console.log(`RPC DEAD  ${c.name} ${c.url} — ${head.error || chain.error}`);
    }
  }

  // The DEX for the Beta listing rehearsal — just proves it answers and what
  // it identifies as; the listing mechanics get read by a human.
  try {
    const r = await fetch("https://tradekoinos.com/", { redirect: "follow", signal: AbortSignal.timeout(12000) });
    const text = await r.text();
    const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1] ?? "";
    console.log(`DEX tradekoinos.com HTTP ${r.status} title="${title.trim().slice(0, 80)}"`);
  } catch (e) {
    console.log(`DEX tradekoinos.com unreachable — ${String(e.message || e).slice(0, 100)}`);
  }

  // The KAI settlement contract production is configured against
  // (foundation testnet, id 149Yv…). Read-only koilib calls: token identity,
  // supply, and whether recent epochs' Merkle roots actually landed on-chain
  // — the difference between "settlement works" and "settlement fails
  // quietly every epoch".
  try {
    const { Provider, Contract } = require("koilib");
    const abi = JSON.parse(require("fs").readFileSync("contracts/kai/abi/kai-abi.json", "utf8"));
    for (const m of Object.values(abi.methods)) {
      m.entry_point = m.entry_point ?? m.entryPoint;
      m.argument = m.argument ?? m.input;
      m.return = m.return ?? m.output;
      m.read_only = m.read_only ?? m.readOnly ?? false;
    }
    const provider = new Provider(["https://testnet.koinosfoundation.org/jsonrpc"]);
    const kai = new Contract({ id: "149YvYQfj4MNaFecd7Rm3Z2rK6y2fkPYXz", abi, provider });
    const read = async (fn, args = {}) => (await kai.functions[fn](args)).result;
    const name = await read("name");
    const symbol = await read("symbol");
    const supply = await read("total_supply");
    console.log(`KAI CONTRACT name=${name?.value} symbol=${symbol?.value} total_supply=${supply?.value ?? "0"}`);

    // Which epoch is production on? Then check the last few for roots.
    const cur = await fetch("https://koinosai.com/scheduler/epoch/current", { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
    console.log(`SCHEDULER epoch=${cur.epoch} receipts=${cur.receipts}`);
    for (let e = Math.max(1, cur.epoch - 5); e < cur.epoch; e++) {
      const root = await read("get_root", { epoch: String(e) }).catch((err) => ({ error: String(err.message).slice(0, 80) }));
      console.log(`ROOT epoch=${e} ${root?.error ? "ERR " + root.error : root?.value ? "ON-CHAIN " + Buffer.from(root.value, "base64url").toString("hex").slice(0, 16) + "…" : "MISSING"}`);
    }
    // Contract id == operator address (Koinos uploads to the signer), so the
    // account paying for settlement can be checked for fuel: recent roots all
    // MISSING with a LIVE RPC smells like an operator out of testnet mana.
    const { utils } = require("koilib");
    const rc = await rpc("https://testnet.koinosfoundation.org/jsonrpc", "chain.get_account_rc", {
      account: utils.decodeBase58("149YvYQfj4MNaFecd7Rm3Z2rK6y2fkPYXz").toString("base64url"),
    });
    console.log(`OPERATOR rc(mana)=${rc.result?.rc ?? "0"} ${rc.error ? "err=" + rc.error : ""}`);
    const tkoin = new Contract({ id: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju", abi: utils.tokenAbi, provider });
    const bal = (await tkoin.functions.balanceOf({ owner: "149YvYQfj4MNaFecd7Rm3Z2rK6y2fkPYXz" })).result;
    console.log(`OPERATOR tKOIN balance=${bal?.value ?? "0"}`);
  } catch (e) {
    console.log(`KAI CONTRACT read failed — ${String(e.message || e).slice(0, 140)}`);
  }

  console.log(`CHAINCHECK ${live ? "OK" : "NO-LIVE-RPC"} live=${live}`);
})();
