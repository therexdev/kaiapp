"use strict";

/*
 * Koinos chain facts, vendored.
 *
 * Counterpart: /workspace/therexdev/koinos-node/electron/lib/constants.js in
 * therexdev/koinos-node (electron/lib/constants.js in that repo). This is a
 * DELIBERATE SUBSET — the node-operator half of that file (docker image tags,
 * service ports, p2p seeds, the ~60 GB chain backup, compose project names)
 * has no meaning here, because Koinos AI never runs a node. If the two ever
 * disagree about an address, that file is the source of truth and this one is
 * stale.
 *
 * The addresses below are FALLBACKS ONLY. KOIN and VHP have migrated on
 * mainnet before, so the canonical addresses are asked of the chain itself at
 * runtime through the get_contract_address system call (see chain-read.js).
 * These are what we use when that call cannot be made.
 */

const KOIN_DECIMALS = 8;
const SATS_PER_KOIN = 100000000n;

const NETWORKS = {
  mainnet: {
    id: "mainnet",
    label: "Koinos mainnet",
    tokenSymbol: "KOIN",
    rpcUrls: ["https://api.koinos.io"],
    localRpcUrl: "http://127.0.0.1:8080",
    explorer: {
      tx: "https://koinosblocks.com/tx/",
      address: "https://koinosblocks.com/address/",
    },
    contracts: {
      koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK",
      vhp: "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq",
      pob: "159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv",
    },
  },
};

/*
 * What a machine needs before it can run a Koinos node. Kept as DATA rather
 * than branching code so a hardware refusal is one edit when the facts change
 * — and so the date below can be shown to the user next to the verdict.
 *
 * arch: every one of the 11 node image tags pinned by koinos-node publishes a
 * single amd64/linux manifest with no arm64 variant, and its compose file
 * carries no `platform:` key, so `docker compose up` fails at image pull on an
 * ARM machine. That is an absence of software, not slowness — do not soften it
 * into "may be slow".
 *
 * Disk is two thresholds, not one: below minFreeGbToRun a node cannot run at
 * all; between the two it can run but only by syncing from genesis, which
 * takes days.
 */
const NODE_REQUIREMENTS = {
  arch: ["x64"],
  minRamGb: 8,
  minFreeGbToRun: 45,
  minFreeGbForQuickSync: 100,
  verifiedOn: "2026-08-18",
  releasesUrl: "https://github.com/therexdev/koinos-node/releases",
};

module.exports = { NETWORKS, KOIN_DECIMALS, SATS_PER_KOIN, NODE_REQUIREMENTS };
