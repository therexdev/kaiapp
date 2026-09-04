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

/*
 * A watchdog, because koilib's provider has no timeout of its own.
 *
 * On 2026-09-04 this script hung on a public RPC call that normally answers in
 * milliseconds, and sat there. With no bound it would have held its runner for
 * GitHub's default six hours — but the quiet damage is worse than the waste: a
 * run that never finishes never becomes a COMPLETED run, so the next check
 * looks for the latest completed one, finds the previous window's, and reads
 * balances four hours stale as though they were current. The probe that exists
 * to notice a stall would itself stall, silently, and still look fine.
 *
 * So: fail, say which call was outstanding, and exit non-zero. A red job is a
 * fact somebody acts on. A hanging job is a fact nobody sees.
 */
const DEADLINE_MS = Number(process.env.KOINOS_PROBE_TIMEOUT_MS || 90_000);
let currentStep = "starting up";
const watchdog = setTimeout(() => {
  console.error(
    `\nTIMED OUT after ${DEADLINE_MS / 1000}s while: ${currentStep}\n` +
    `RPC ${RPC} did not answer. The wallet reading for this window is MISSING — ` +
    `do not treat the previous window's numbers as current.`
  );
  process.exit(1);
}, DEADLINE_MS);
watchdog.unref?.();

(async () => {
  const provider = new Provider([RPC]);
  currentStep = "fetching head info";

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
  currentStep = "reading the VHP balance";
  /*
   * A failed balance read must NOT pass for a successful one.
   *
   * balanceOf swallows its error and hands back an "ERR …" string, which
   * sats() then renders as NaN — so an unreachable RPC used to print
   * "NaN VHP" and exit ZERO. The job goes green, the run completes, and the
   * only thing standing between that and a false all-clear is somebody
   * reading the word NaN in a log. These two numbers are the entire point of
   * the probe; if either is not a number, the probe did not do its job.
   */
  const failures = [];
  console.log("VHP BALANCE  (per contract asked)");
  let vhpOk = false;
  for (const id of vhpCandidates) {
    currentStep = `reading the VHP balance from ${id}`;
    const b = await balanceOf(provider, id, ADDRESS);
    console.log(`  ${id}  ${sats(b)} VHP   (raw ${b})`);
    if (!String(b).startsWith("ERR")) vhpOk = true;
  }
  if (!vhpOk) failures.push("VHP balance unreadable from every candidate contract");

  const koinId = String(resolved.koin || "").startsWith("ERR") ? FALLBACK.koin : resolved.koin;
  currentStep = "reading the KOIN balance";
  const kb = await balanceOf(provider, koinId, ADDRESS);
  console.log(`KOIN BALANCE ${koinId}  ${sats(kb)} KOIN   (raw ${kb})`);
  if (String(kb).startsWith("ERR")) failures.push("KOIN balance unreadable");
  console.log("");

  /*
   * Where this wallet's KOIN came from, most recent first.
   *
   * Balances alone cannot tell block production from a deposit, and I spent
   * four windows reporting "unexplained KOIN inflow" at the owner before
   * being told what it was: the project node makes daily drops rewarding
   * testers for being on the network. The balance was never the missing
   * information — the sender and the timestamp were, and both are public.
   *
   * Printed as STATE, not asserted. The real alarm worth having is "the
   * tester rewards STOPPED", and setting that threshold needs the actual
   * cadence, which this is here to measure. Guessing one from four samples
   * is how the block-production stall got mis-reported at 3 zero windows
   * when the honest number was 4; the same mistake is available here and I
   * am not making it twice. Revisit once there are a couple of weeks of
   * these lines to read a real interval off.
   *
   * Entirely best-effort: account_history is a separate microservice from
   * the chain RPC and may not be exposed on every endpoint. It must never
   * cost us the balance reading, which is this probe's actual job.
   */
  currentStep = "reading recent KOIN transfers";
  try {
    const hist = await provider.call("account_history.get_account_history", {
      address: ADDRESS, limit: 8, ascending: false, irreversible: false,
    });
    const recs = hist?.values || [];
    console.log(`KOIN HISTORY (${recs.length} most recent records)`);
    for (const r of recs) {
      const t = r?.trx?.transaction?.header?.payer;
      // Timestamps arrive as ms-since-epoch strings on the block header.
      const ms = Number(r?.trx?.transaction?.timestamp || r?.block?.header?.timestamp || 0);
      const when = ms > 0 ? new Date(ms).toISOString() : "unknown-time";
      const ops = r?.trx?.transaction?.operations || [];
      const calls = ops.map((o) => o?.call_contract?.contract_id).filter(Boolean).join(",");
      console.log(`  ${when}  payer=${t || "?"}  contracts=${calls || "-"}`);
    }
    if (recs.length === 0) console.log("  (none returned — endpoint may not expose account_history)");
  } catch (e) {
    // Not a failure: no reading is lost, only the extra colour.
    console.log(`KOIN HISTORY unavailable — ${String(e?.message || e).slice(0, 160)}`);
  }
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

  if (failures.length) {
    console.error(
      `\nPROBE INCOMPLETE — ${failures.join("; ")}. ` +
      `The wallet reading for this window is MISSING; do not treat the previous ` +
      `window's numbers as current.`
    );
    process.exitCode = 1;
  }
})().then(
  () => clearTimeout(watchdog),
  (e) => {
    clearTimeout(watchdog);
    console.error("PROBE FAILED", e);
    process.exit(1);
  }
);
