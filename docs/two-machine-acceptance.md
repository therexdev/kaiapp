# §46.3 Acceptance: two real machines, one economy

The V1 non-negotiable this run proves: *a real decentralized inference job can
be routed, completed, verified, and reliably settled in KAI* — with the
consumer and the provider on **different physical machines**.

Time: ~30 minutes, mostly waiting on two 15-minute epoch boundaries.

## Cast

- **Machine A (provider)** — your main machine, already earning.
- **Machine B (consumer)** — any second Windows/Linux machine. It will *not*
  earn in this run; it only consumes.

## Steps

1. **Machine A**: open the app → Earn tab → confirm **Status: Earning** and
   note the wallet address (call it `A`).
2. **Machine B**: install the app from the latest release
   (github.com/therexdev/kaiapp/releases → `Koinos-AI-Setup-<version>.exe`).
   Complete onboarding (model download). Then:
   - Earn tab → **create a wallet** (write down the backup code) — this is
     identity for network usage; you do NOT need to press Start Earning.
   - Set the scheduler URL to `https://koinosai.com/scheduler`.
   - Local API tab → Network & privacy → set **Network**.
3. **Machine B**: in the chat composer pick **Koinos Network** and send a few
   prompts, at least one long one (paste a page of text). Machine A's fans
   are the proof of routing; B's Earn tab shows *Network usage* climbing in
   tokens, spending its 25,000-token free allowance.
4. **Optional (paid path)**: on B, exhaust the free allowance (or wait for
   the next epoch and set `KAI_FREE_TOKENS=0` server-side for a strict run) —
   B's requests then require funds: convert KAI with **Add funds** (needs B to
   hold KAI; send some from A via any Koinos wallet, or ask the operator to
   run a claim to B's address).
5. **Wait for the epoch tick** (quarter-hour): the scheduler closes the epoch,
   submits the Merkle root, and settles claims **automatically**.

## What to verify (all public)

- `https://koinosai.com/scheduler/epoch/current` — receipts under address `A`
  while B chats.
- `https://koinosai.com/scheduler/pricing` — the rates B was billed at.
- After the tick: A's **KAI balance** row rises by the epoch's net value —
  eval subsidies plus the *token-metered value* of the chats it served for B.
- On-chain: A's balance via any Koinos testnet explorer, or the app itself.

## Pass criteria (§46.3)

| # | Check | Where |
|---|---|---|
| 1 | B's network chat answered by A | B sees replies with the network model |
| 2 | Receipts recorded and signed by A | epoch/current totals[A] > 0 |
| 3 | B billed by actual tokens | B's Earn tab Network usage row |
| 4 | Epoch closed + root on-chain + claim minted | A's KAI balance increases without any manual step |
| 5 | Privacy: switching B to Local-Only hides/refuses the network model | B's model picker + chat |

Record the epoch number, root, and tx ids from
`/scheduler/operator/epochs` (operator secret required) in the master doc's
acceptance ledger.

---

## Acceptance record — 2026-08-15 (PASSED)

Run executed by the operator with app **v0.8.0** against the production
scheduler at `https://koinosai.com/scheduler` and KAI contract
`149YvYQfj4MNaFecd7Rm3Z2rK6y2fkPYXz` (Koinos testnet).

**Cast**

| Role | Address | Notes |
|---|---|---|
| Machine A (provider) | `1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK` | earning; served all jobs |
| Machine B (consumer) | `1EXvuuW5HMrYRPdkraSi5Z4TBd4djyMj6E` | fresh wallet, **0 KAI held**, never funded |

**The two-machine epoch: 29779588** (closed + settled `2026-08-15T06:43:38Z`)

- B sent **10** network chat requests; A served **15** receipts (10 chat + 5 eval).
- B metered at actual AI tokens: **12,426 in / 2,302 out** (14,728 total),
  `costMicro: 0` — fully absorbed by the 25,000-token free allowance (§16
  bootstrap). B paid nothing and held no KAI at any point.
- A's earnings, token-metered at the published PROVISIONAL rates
  ($0.10/M in, $0.40/M out, KAI ref $0.01):
  5 × 1 KAI eval subsidy + 0.2168 KAI chat value = **5.2168 KAI**
  (`521680000` satoshis, exact netting, single-leaf Merkle claim).
- Merkle root `523a02671670277894db7fc5fa270056d3012975a963a1b9381d137f21eca578`
  - `submit_root` tx `0x1220959024ca11ab33d7ed582a8b61aa82958d8e62919cfd417c0c471a2a47b20607`
  - `claim_value` tx `0x12205756b169ad5c3d79aede820d9f596f6f8650fa537930cbfa50d5cdff609dbd7b`
- A's on-chain balance: **19.0071 → 24.2239 KAI**, automatically at the
  quarter-hour tick. (The preceding warm-up epoch 29779573, single-machine,
  settled 4.0071 KAI: root tx `0x122098…2ee2`, claim tx `0x122050…d6e5`.)

**Pass criteria**

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | B's network chat answered by A | PASS | 10 requests under B's address, 2,302 output tokens returned; replies observed on B |
| 2 | Receipts recorded and signed by A | PASS | epoch `totals[A] = 521680000` sat across 15 honest receipts |
| 3 | B billed by actual tokens | PASS | epoch `usage[B] = {inTok: 12426, outTok: 2302}`, free-allowance drawdown |
| 4 | Epoch closed + root on-chain + claim minted, no manual step | PASS | root + claim txs above; A's balance +5.2168 KAI at the tick |
| 5 | Local-Only hides/refuses the network model on B | PASS | operator-verified in-app; fenced by the zero-bytes proof in `core/test/network.test.js` |

*The V1 non-negotiable is proven: a real decentralized inference job was
routed between two physical machines, completed, verified, and reliably
settled in KAI — with consumer privacy and metering enforced end to end.*
