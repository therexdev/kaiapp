#!/usr/bin/env node
"use strict";

/*
 * Why one address reports two different VHP numbers.
 *
 * The desktop Node screen reads the wallet's VHP balance off chain. The block
 * producer prints "Producing with X VHP" from inside the node. On one field
 * machine those disagreed by 2.4x — same computer, same address — and a
 * dashboard that shows either number without knowing which is right is a
 * dashboard that lies about someone's money.
 *
 * This runs on a CI runner because the dev sandbox's proxy cannot reach
 * api.koinos.io. Read-only: balances and contract metadata, no keys, no
 * transactions. The address is a public mainnet address and is passed in.
 *
 * The specific suspicion it exists to test: KOIN and VHP have MIGRATED
 * contracts on mainnet before, and the app resolves their addresses at
 * runtime through get_contract_address while falling back to vendored
 * constants. If the resolved VHP contract is not the one the vendored
 * constant names, then "the balance" depends on which contract you ask —
 * and the app and the node could each be reading a different, real answer.
 */

const { Provider, Contract } = require("koilib");

const RPC = process.env.KOINOS_RPC || "https://api.koinos.io";
const ADDRESS = process.argv[2];
if (!ADDRESS) {
  console.error("usage: vhp-probe.js <address>");
  process.exit(2);
}

const TOKEN_ABI = require("../lib/koinos/token-abi.json");
const POB_ABI = require("../lib/koinos/pob-abi.json");
const { NETWORKS } = require("../lib/koinos/constants");
const FALLBACK = NETWORKS.mainnet.contracts;

const sats = (v) => (v == null ? "—" : (Number(v) / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 }));

async function balanceOf(provider, contractId, owner) {
  try {
    const c = new Contract({ id: contractId, abi: TOKEN_ABI, provider });
    const r = await c.functions.balance_of({ owner });
    return r?.result?.value ?? "0";
  } catch (e) {
    return `ERR ${String(e.message || e).slice(0, 90)}`;
  }
}

(async () => {
  const provider = new Provider([RPC]);

  const head = await provider.getHeadInfo().catch((e) => ({ error: String(e.message) }));
  console.log(`RPC        ${RPC}`);
  console.log(`HEAD       ${head?.head_topology?.height ?? head?.error}`);
  console.log(`ADDRESS    ${ADDRESS}`);
  console.log("");

  // 1. Which contracts does the CHAIN say are canonical right now?
  const resolved = {};
  for (const name of ["koin", "vhp", "pob"]) {
    try {
      const r = await provider.invokeGetContractAddress(name);
      resolved[name] = r?.value?.address || null;
    } catch (e) {
      resolved[name] = `ERR ${String(e.message || e).slice(0, 60)}`;
    }
  }
  console.log("CONTRACT ADDRESSES  (resolved via get_contract_address vs the app's vendored fallback)");
  for (const name of ["koin", "vhp", "pob"]) {
    const same = resolved[name] === FALLBACK[name];
    console.log(`  ${name.padEnd(4)} resolved=${resolved[name]}`);
    console.log(`       vendored=${FALLBACK[name]}  ${same ? "SAME" : "*** DIFFERENT ***"}`);
  }
  console.log("");

  // 2. The balance, asked of EVERY VHP contract in play. If these disagree,
  //    that is the entire bug and it is not a rounding error.
  const vhpCandidates = [...new Set([resolved.vhp, FALLBACK.vhp].filter((x) => x && !String(x).startsWith("ERR")))];
  console.log("VHP BALANCE  (per contract asked)");
  for (const id of vhpCandidates) {
    const b = await balanceOf(provider, id, ADDRESS);
    console.log(`  ${id}  ${sats(b)} VHP   (raw ${b})`);
  }
  const koinId = String(resolved.koin || "").startsWith("ERR") ? FALLBACK.koin : resolved.koin;
  const kb = await balanceOf(provider, koinId, ADDRESS);
  console.log(`KOIN BALANCE ${koinId}  ${sats(kb)} KOIN   (raw ${kb})`);
  console.log("");

  // 3. What the PoB contract itself thinks the network looks like — the
  //    denominator the block producer's "estimated total VHP" comes from.
  const pobId = String(resolved.pob || "").startsWith("ERR") ? FALLBACK.pob : resolved.pob;
  try {
    const pob = new Contract({ id: pobId, abi: POB_ABI, provider });
    const meta = await pob.functions.get_metadata({});
    console.log("POB METADATA", JSON.stringify(meta?.result ?? meta, null, 2).slice(0, 800));
    const cons = await pob.functions.get_consensus_parameters({}).catch(() => null);
    if (cons) console.log("POB CONSENSUS", JSON.stringify(cons?.result ?? cons, null, 2).slice(0, 500));
    // Is a public key registered for this producer? An unregistered producer
    // is a different failure than a wrong balance, and looks the same from
    // the outside.
    const pk = await pob.functions.get_public_key({ producer: ADDRESS }).catch((e) => ({ error: String(e.message).slice(0, 80) }));
    console.log("POB PUBLIC KEY", JSON.stringify(pk?.result ?? pk).slice(0, 300));
  } catch (e) {
    console.log("POB ERR", String(e.message || e).slice(0, 160));
  }
})().catch((e) => {
  console.error("PROBE FAILED", e);
  process.exit(1);
});
