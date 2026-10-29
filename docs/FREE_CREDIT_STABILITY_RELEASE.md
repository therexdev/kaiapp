# Free-credit stability and compact balances

Install the matching Koinos AI Test build for the compact balance card and quieter
labels. Apply this server update once to fix the free allowance disappearing during
slow payment/reward processing on Pi, Windows and other clients. This also includes
the daily reward-summary endpoint; no separate summary update is necessary.

Run the complete block in the existing `root@koinos-scheduler` terminal:

```bash
(
set -euo pipefail
umask 077
KAI_FREE_RELEASE=daf2dc4cb19c84412f00d8552b348ebb4a8e0bd8
test "$(id -u)" = 0
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) throw Error("System Node 22 or newer required")'
KAI_FREE_STAGE=$(mktemp -d /root/kai-free-allowance.XXXXXXXX)
git -C "$KAI_FREE_STAGE" init --quiet
git -C "$KAI_FREE_STAGE" fetch --quiet --no-tags --depth=24 https://github.com/therexdev/kai.git "$KAI_FREE_RELEASE" 4f108fedf9f0e35d33635989d38b5c8c3aa9fa3c
git -C "$KAI_FREE_STAGE" checkout --quiet --detach "$KAI_FREE_RELEASE"
cd "$KAI_FREE_STAGE"
test "$(git rev-parse HEAD)" = "$KAI_FREE_RELEASE"
npm ci --ignore-scripts
node deploy/koin-mainnet/update-free-allowance.js
)
```

Success ends with **Free allowance refresh and daily reward summaries installed
and verified on loopback and HTTPS**. The app reads its next balance within
about 15 seconds. Free usage remains subject to the existing account and network
limits, actual funding and fresh chain verification.

The updater accepts only the exact prior model-readiness release
(`4f108fedf9f0e35d33635989d38b5c8c3aa9fa3c`) or reward-summary release
(`5b954887162376fc03abecbbd92f1b1d603d232e` / merge
`c529f05c8ce3209dbd92eef227799d77c3d5d6d8`). An unexpected installed
version or concurrent configuration change stops the update without replacing it.
It preserves keys, balances, configuration, qualifications, journals and pending
transactions. It does not fund the pool or change free-credit limits.

The health endpoint exposes `freeAllowanceRefreshVersion: 1` and
`rewardSummaryVersion: 1`. These identify the reporting code; they do not
guarantee current sponsorship availability or reward settlement.
