# Daily KOIN earnings above the reward feed

For new installations, use the [combined free-credit stability update](FREE_CREDIT_STABILITY_RELEASE.md), which includes these reward summaries.

Update the existing prepaid service once, then install the matching Koinos AI
Test app. The app shows estimated availability accumulated during the current
UTC reward day and a separate total awaiting review or automatic payment.
Availability and completed-work amounts remain separate. The displayed review
deadline is the earliest eligibility for finalization, not a promised send time.

Run this complete block in the existing `root@koinos-scheduler` terminal:

```bash
(
set -euo pipefail
umask 077
KAI_REWARD_RELEASE=5b954887162376fc03abecbbd92f1b1d603d232e
test "$(id -u)" = 0
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) throw Error("System Node 22 or newer required")'
KAI_REWARD_STAGE=$(mktemp -d /root/kai-reward-summary.XXXXXXXX)
git -C "$KAI_REWARD_STAGE" init --quiet
git -C "$KAI_REWARD_STAGE" fetch --quiet --no-tags --depth=16 https://github.com/therexdev/kai.git "$KAI_REWARD_RELEASE" 4f108fedf9f0e35d33635989d38b5c8c3aa9fa3c
git -C "$KAI_REWARD_STAGE" checkout --quiet --detach "$KAI_REWARD_RELEASE"
cd "$KAI_REWARD_STAGE"
test "$(git rev-parse HEAD)" = "$KAI_REWARD_RELEASE"
npm ci --ignore-scripts
node deploy/koin-mainnet/update-reward-summary.js
)
```

Success ends with **Daily reward summaries installed and verified on loopback
and HTTPS**. Repeating the exact update reports it is already installed. The
updater expects the earlier combined automatic-free-access/model-readiness
release. If a different service version or concurrent change is present, it
stops without replacing that work.

This updates reporting code only. Configuration, keys, balances, qualifications,
payment journals and reward rules are preserved. A failed health check restores
the previous code while keeping current journals. No manual wallet claim is
introduced. The app continues to show its existing payout history on older
servers, with the new estimates marked unavailable until this update is installed.

The health capability `rewardSummaryVersion: 1` confirms the new reporting
interface. It does not prove that settlement is healthy. If Earn reports a stale
processing check, inspect the service's operator status before promising a
payout time or treating missing availability as a zero balance.
