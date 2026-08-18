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

  console.log(`CHAINCHECK ${live ? "OK" : "NO-LIVE-RPC"} live=${live}`);
})();
