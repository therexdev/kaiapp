# M2 — Earning Alpha (§46: 3, 4)

> Status: STEPS 1-5(v0) PROVEN LIVE (2026-08-15). The §46.4 loop ran end to end against the
> real Koinos Foundation testnet: routed -> completed -> verified -> SETTLED. Epoch root
> f59dfa6b… anchored in tx 0x122049bf…a78f8f (v0 address-commitment), independently verified
> on-chain. Reproduce: fund an operator key via the Telegram faucet, then
> `KAI_OPERATOR_WIF=… node server/scripts/demo-loop.js`. UPDATE: **KAI claim contract DEPLOYED AND PROVEN** (2026-08-15) at
> `149YvYQfj4MNaFecd7Rm3Z2rK6y2fkPYXz` — real epoch root submitted (tx 0x1220bcae…4216), real
> Merkle claim (tx 0x12207c0e…c38c), 2 KAI minted to the provider, balance verified on-chain.
> Operator pays all MANA (§21: providers never need KOIN). Earn UI shipped in v0.2.0.
> Remaining for M2 close-out: §46.3 two-machine acceptance run.
> Original status: READY TO BUILD (2026-08-15). Prereq M1 shipped (v0.1.1 live, auto-updating).
> Governed by Part I of the Master Source of Truth; §-refs point there. Alpha settles on
> **harbinger testnet** (working choice in V1_PLAN §2); mainnet at a §48 readiness gate.

## Shape

Monorepo for alpha velocity: the scheduler lives in `server/` here (zero-dep Node, same house
style as `core/`); split into its own repo when it grows real ops. Client modules land in
`core/lib/`. Every step mirrors M1's proven loop: build with a fake counterpart fixture →
integration-test the full chain → CI (`[pin-verify]`-style commit triggers) → release via
`[release]` and the auto-updater.

## Build order (each step is one M1-style increment with tests)

1. **Wallet module** (`core/lib/wallet.js`) — port Koinos-Node `electron/lib/wallet-service.js`
   + keystore verbatim (same encrypted-JSON format, scrypt+AES). §5/§22: account auto-created
   when the user first opts into earning; no seed phrase in the consumer flow (export lives in
   Advanced); wallet keys never leave Core, never become API keys (§8).
2. **Scheduler skeleton** (`server/scheduler.js`) — HTTP long-poll worker protocol (outbound
   connections only, §13: no inbound ports on providers): `POST /worker/register` (capability
   report from hardware.detect + benchmark), `GET /worker/next-job` (long-poll), `POST
   /worker/result`. Job types alpha-only + protocol-funded (§16, §31 approved profiles):
   `inference-eval` (prompt → completion on the loaded model) and `benchmark`. Receipts stored
   append-only (JsonStore per epoch); scheduler is project-operated and stateless-restartable.
3. **Worker module** (`core/lib/worker.js`) — Earn opt-in starts it: registers with scheduler
   URL (`KAI_SCHEDULER_URL`), long-polls, runs jobs through the local runtime ladder, submits
   signed receipts (wallet key signs job-result hashes — the §17 receipt primitive). Honors
   §10 guards: pause immediately on user toggle; battery/thermal deferred to M4 note.
4. **Verification + epochs** (`server/`) — hidden-challenge sampling (§17 minimal): scheduler
   seeds known-answer jobs at a sampling rate; mismatches flag the provider. Epoch close →
   receipt aggregation → per-provider totals → **Merkle root** (reuse hash discipline from
   §27 modules).
5. **Settlement on harbinger** — KAI test token + claim contract (Koinos smart contracts; new
   `contracts/` dir; koinos-node's `harbinger/` node-template + NodeManager run the project
   node). Batcher commits the epoch root; provider claims with a Merkle proof; claims are
   **MANA-sponsored** via the relayer pattern already implemented in Koinos-Node's sponsor
   endpoint (§21 — provider never needs KOIN).
6. **Earn UI** — the stubbed tab comes alive: Start/Stop Earning, session job count, **KAI
   earned + est. value, never CU** (§14), scheduler connection status. Same control-plane
   pattern (`/core/earn/*`).

## Acceptance (unchanged from V1_PLAN M2)

§46.3: fresh machine → install → one action → earning. §46.4: a real job routed → completed →
verified → settled in KAI on harbinger, demonstrated across ≥2 real machines.

## Reuse map (verified in the M1 survey)

| Need | Source in `therexdev/koinos-node` |
|---|---|
| Keystore + WalletService | `electron/lib/wallet-service.js` (copy as-is) |
| Chain RPC + tx submission | `electron/lib/chain-service.js` |
| MANA sponsorship relayer | sponsor endpoint (implements §21 checks already) |
| Harbinger node ops | `node-template/harbinger/` + NodeManager |

## Risks logged up front

Scheduler hosting (needs a URL — alpha can run on the same Hostinger box or any VPS; config
via env), harbinger RPC reliability (run our own node — see reuse map), and clock/epoch edge
cases (epoch boundaries defined server-side only; workers never self-report time).
