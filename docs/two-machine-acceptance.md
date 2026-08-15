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
