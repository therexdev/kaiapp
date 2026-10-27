# Automatic free access and model readiness

**Update Vultr once, update Koinos AI Test, then use the app.** This combined
release replaces the earlier wallet-access and earning-recovery update
instructions. It adds automatic free access, wallet-protected saved connections
on computers without a system keyring, and fresh runtime checks for shared
models instead of the generic twelve-question quality exam.

## 1. Update Vultr

In the existing `root@koinos-scheduler` terminal, paste this complete block:

```bash
(
set -euo pipefail
umask 077
KAI_READINESS_RELEASE=4f108fedf9f0e35d33635989d38b5c8c3aa9fa3c
KAI_READINESS_APPROVE=cceef6d7c972b1c744f5d76d2513a929ff2f7af044c234fefe501aaa6b3059bb
[[ "$KAI_READINESS_RELEASE" =~ ^[0-9a-f]{40}$ ]]
[[ "$KAI_READINESS_APPROVE" =~ ^[0-9a-f]{64}$ ]]
test "$(id -u)" = 0
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) throw Error("System Node 22 or newer required")'
KAI_READINESS_STAGE=$(mktemp -d /root/kai-model-readiness.XXXXXXXX)
git -C "$KAI_READINESS_STAGE" init --quiet
git -C "$KAI_READINESS_STAGE" fetch --quiet --no-tags --depth=16 https://github.com/therexdev/kai.git "$KAI_READINESS_RELEASE" 80eb56c94600b800c0b69910acde0937f0da052d
git -C "$KAI_READINESS_STAGE" checkout --quiet --detach "$KAI_READINESS_RELEASE"
cd "$KAI_READINESS_STAGE"
test "$(git rev-parse HEAD)" = "$KAI_READINESS_RELEASE"
git merge-base --is-ancestor 80eb56c94600b800c0b69910acde0937f0da052d HEAD
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=high
node deploy/koin-mainnet/update-model-readiness.js --approve "$KAI_READINESS_APPROVE"
)
```

The updater supports either installed backend
`b85363e6c6188fb215e9a98fc8fdaed5869ede75` or
`80eb56c94600b800c0b69910acde0937f0da052d`, and an exact repeat of this release.
It checks prerequisites and runs regressions before restarting the dedicated
prepaid service. Success ends with **Reviewed model readiness installed and
verified on loopback and HTTPS** and the release commit; an exact repeat reports
that it is already installed and verified.

The command checks automatic free access and the exact reviewed model policies
on the running service. It preserves keys, accounts, balances, payment and
reward records, previous qualification evidence, prices and reward economics.
If activation fails, it restores the previous code and configuration while
retaining newly written records. No contract deployment or additional funding
is part of this update.

## 2. Update the app

After the server update succeeds, install the accompanying **Koinos AI Test**
release through the app's normal update control. The matching Windows Setup
and Linux ARM64 AppImage are also on the
[Test release page](https://github.com/therexdev/kaiapp/releases/tag/test-build).
Existing wallets, models, chats, node paths and balances remain in the shared
profile.

If an older Pi build fails while applying its update, quit that app and launch
the new ARM64 AppImage directly. The fixed updater is included in the new app;
it cannot replace the updater code already running in an older process.
Launching the AppImage creates or refreshes its application-menu and desktop
launcher. The desktop may ask for its normal **Allow Launching** action.

## 3. Use the app

- **Free network chat:** choose Network in Chat and send a message. Free access
  connects automatically without creating an account, connecting a KOIN wallet,
  unlocking it, or installing a system keyring. Credits shows the service's
  actual sponsored allowance; eligible models, funding and daily network
  budgets still apply. Reconnecting or restarting retains this installation's
  spent allowance.
- **Buy credits:** enter the dollar amount and click **Buy credits**. The KOIN
  estimate refreshes before purchase. If needed, unlock the app wallet and
  approve its connection in the same flow, then approve the exact payment.
  Separate email signup is optional. Existing balances and saved payments stay
  associated with their original wallet or account.
- **Earn:** turn earning on and leave the selected models enabled. The app loads
  each selected compatible model for two fresh signed runtime checks; no chat
  message is needed. Passing models serve on demand, with already-ready
  capacity available between checks. Models need not all fit in memory at once.
  Each model's actual readiness and any failure reason remain visible.

On a Pi or other computer without a protected system keyring, saved network
access is encrypted through the app wallet. Unlock the wallet once after an
app restart to open that access; it can then be locked again while authorized
earning continues. Purchases still need their own wallet approval. Automatic
free access does not require that unlock. Previously saved system-keyring
credentials are preserved if their original store is unavailable; the app
does not silently replace a locked paid connection.

A genuinely new desktop profile starts in **Local-First**. Existing profiles
retain their privacy setting, including Local-Only; headless/Core defaults are
unchanged. Local-Only continues to block network access. The automatic free
identity cannot purchase credits, spend paid balances, authorize earning,
administer an account or access another installation's requests. It is separate
from financial wallets and does not merge accounts.

## What the checks establish

Readiness verifies fresh signed inference using each exact approved model
package, tokenizer and conversation template. Both short label-copy/recall
checks must finish within the reviewed limits; incomplete or incorrect answers
do not pass. Evidence expires after one day and renews automatically. This is
a runtime check, not a claim of perfect general knowledge or instruction
following. Earlier twelve-question results remain historical evidence and are
never relabeled as successful readiness.

Actual pinned Fast, Gemma 3 4B, Llama 3.1 8B and Mistral 7B weights passed all
**40/40** measured checks, with exact native token-ID agreement and completed
generation. The other eleven catalog models were not measured in that run;
their providers must pass their own fresh checks. HTTP integration tests also
cover automatic free chat, restart and response recovery, wallet connection,
signed provider results, model switching and one effective reward capacity.

These checks do not establish physical Raspberry Pi performance or the user's
Pi desktop integration. An ONLINE indicator is evidence of current service
readiness; it is not proof of a distributed reward. Reward funding, payout
cycles and Mana requirements retain their existing configuration.
