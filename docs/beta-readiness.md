# Beta readiness — status, baselines, and what still needs the owner

*2026-08-18. Written as the record of the Beta-track build (tasks #51–#53).
Facts below are live-probed, not assumed; the probe is
`core/scripts/chain-probe.js`, run from CI (`[chaincheck]` tag) because the
dev sandbox has no chain egress.*

## 1. The testnet KAI token — further along AND more broken than believed

The story until today was "the KAI contract is built but not deployed, and
the testnet RPC it would need does not publicly exist." **Both halves were
wrong**, live-probed 2026-08-18:

- **The Foundation testnet is ALIVE**: `https://testnet.koinosfoundation.org/jsonrpc`,
  chain id `EiAIKVvm6-V2qmsmUvPJy09vCCLbtn9lHFpwrJbcTIEWRQ==` (matches the
  pinned preset), head ~7.62M. Harbinger's public API
  (`harbinger-api.koinos.io`) is the dead one.
- **The KAI contract is DEPLOYED and functioning** at
  `149YvYQfj4MNaFecd7Rm3Z2rK6y2fkPYXz` (the operator's own address):
  `name=Koinos AI Token, symbol=KAI, total_supply=392521535199` —
  **3,925.21 KAI already minted** by past epoch claims.
- **But current settlement is failing quietly**: the last five epochs'
  roots are all MISSING on-chain, while the RPC answers and the operator
  holds ~100 tKOIN (balance probed on-chain — fuel is NOT the cause).

### Diagnosing the quiet failure (next concrete steps)

The failure reason is recorded per-epoch in `summary.settlement.error`,
which the NEW public endpoint exposes:

    GET https://koinosai.com/scheduler/claims?address=<any worker address>

Each claim entry carries `settlement.rootTx / claim tx / error`. **This is
deployed the moment the kai production branch is updated** (see §4 —
blocked on the owner). Likeliest suspects once the error is visible: an
env override on the box (`KAI_RPC_URL` pointing somewhere dead), a koilib
`wait()` timeout being treated as failure, or nonce contention.

### Owner runbook — testnet KAI verification (10 minutes, on the box)

1. `grep -E "KAI_RPC_URL|KAI_CHAIN|KAI_CONTRACT" /opt/koinos/kai.env` —
   any KAI_RPC_URL there overrides the (working) default; if it points at
   harbinger or anything else, delete it or set it to
   `https://testnet.koinosfoundation.org/jsonrpc`.
2. `journalctl -u koinos | grep -E "settle-failed|settle-withheld" | tail`
   — the actual error text, tonight.
3. After the claims endpoint deploys, anyone can watch settlement heal:
   `curl "https://koinosai.com/scheduler/claims?address=1EXvuuW5HMrYRPdkraSi5Z4TBd4djyMj6E"`.

### Beta listing rehearsal (tradekoinos.com)

Probed live: `tradekoinos.com` answers — "Trade Koinos — the lossless
on-chain orderbook DEX." It trades MAINNET tokens, so the real listing
happens at mainnet launch; the contract already implements the full
KCS-4 surface a DEX needs (name/symbol/decimals/total_supply/
balance_of/transfer — probed on-chain). The Beta rehearsal is: deploy the
same wasm to mainnet behind the kill switch with claims disabled, list,
verify the pair renders and trades dust, THEN open claims at launch.
That deploy is `lib/chain.js` `KaiContract.deploy()` with `KAI_CHAIN=mainnet`
— one command on the box, owner-gated.

## 2. Anti-Sybil signal #3 — device fingerprint binding (SHADOW), shipped

- **App** (v0.28.5): the worker sends `Worker.fingerprint(hardware)` with
  registration — sha256 over platform/arch/CPU model+cores/rounded-GB
  RAM/sorted GPU names, 16 hex chars. Deterministic across boots and
  byte-level RAM wobble; changes when the hardware does; identical for
  every wallet on one device — which is the point. Coarse by construction;
  no serials, nothing personal.
- **Scheduler**: validates shape, stores it durably beside
  firstSeen/repPaidJobs, keeps the last good one when a registration omits
  or garbles it. Surfaces `fp` (8 chars) + `fpPeers` per worker in
  /network/status detail, and records `fingerprintGroups` (the
  {fingerprint: [addresses]} collision map) in every epoch summary beside
  reputationShadow.
- **NOT enforced anywhere.** The probe proves identical work still settles
  identically across a collision (equal work, equal pay). Enforcement
  waits for the owner's four gate decisions; recommendation stands:
  R_GATE 0.45, two-week shadow, fingerprint as an eligibility signal only.

Probes: kai `scripts/probe-fingerprint.js` (7 checks fail on the previous
build), kaiapp `core/test/fingerprint.test.js`.

## 3. Stress baseline — the scheduler is not the Beta bottleneck

`kai scripts/stress-swarm.js` boots a LOCAL scheduler (sqlite) and drives
the REAL protocol end to end (register + fingerprint, long-poll, chunks,
signed results, signed consumer chats). Never points at production.

Measured on a 4-core dev box, synthetic serve ≈600ms/job:

| run | throughput | p50 / p95 | spread | epoch close | status under load |
|---|---|---|---|---|---|
| 40 workers, 400 chats @ 25 | 36 chats/s | 643ms / 913ms | serving workers within 14–19 jobs each | 26ms | 2ms |
| 80 workers, 1600 chats @ 60 | 44 chats/s | 873ms / 3.7s | 80/80 served, top worker 49/1600 | 63ms over 1600 receipts | 7ms |

Also proven in-harness: every chat answered (0 drops), the per-IP free
ceiling pauses free usage with the friendly 402, every serving worker
holds a claim packet, and the fingerprint collision group lands in the
epoch record at scale. One design note the harness made legible: §51
perf-fed routing CONCENTRATES paid work on measured-fast workers when
serve time is zero — by design; fair seeding covers cold start; with
realistic serve times distribution is concurrency-bound and even.

Conclusion: at Beta scale (dozens of machines, tens of chats/second) the
scheduler and sqlite store have an order of magnitude of headroom on a
$6 VPS. The bottleneck will be model inference on providers' machines,
which is the thing Beta is supposed to measure.

## 4. Blocked on the owner

1. **Merge the kai dev branch into the production branch** (compare page:
   base `claude/kai-production-website-fqx4pf`, compare
   `claude/koinos-ai-takeover-co25fw` — verified clean, no conflicts).
   Ships the claims endpoint, chain presets, fingerprint shadow, stress
   harness, and the §20 paid-only splits fix (`e3a5340`). NOTE the
   correction from an earlier revision of this doc: the treasury address
   travels in git (`deploy/app.env`), so the merge itself ACTIVATES §20
   splits — that is now safe and owner-approved (2026-08-19) because
   splits divide PAID chat value only; free-tier emission passes through
   whole (pinned by `scripts/probe-splits.js` §6). The box auto-deploys
   within a minute; expect ONE scheduler restart.
2. **Settlement diagnosis** — after the merge, read `settlement.error`
   from `/scheduler/claims?address=…` (no box access needed), or run
   runbook §1 on the box (10 minutes).

### Decided 2026-08-19 (no longer blocking)

- **Anti-Sybil gates**: fingerprint binding enforces first; reputation
  gate stays at the shipped 0.45 default; two weeks of clean shadow from
  the production deploy of the fingerprint signal before anything arms.
  Recorded beside the flags in kai `deploy/app.env`.
- **§20 treasury**: activate, with the paid-only split semantics above.
- **Mainnet listing rehearsal** (§1): plan approved — deploy the same
  wasm to mainnet behind the kill switch with claims disabled, list on
  tradekoinos, verify dust trades, open claims at launch. Executes once
  testnet settlement is proven end-to-end.
