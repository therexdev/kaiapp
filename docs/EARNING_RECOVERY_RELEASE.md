# Earning recovery service update

Use this once for the existing prepaid service after the unlimited-purchase update.
The tested backend is `80eb56c94600b800c0b69910acde0937f0da052d`.
Koinos AI Test 0.54.13-test.226.1 and later include the matching desktop changes.
The separate Raspberry Pi update/restart fix needs only the newer app.

Run this complete block in the existing `root@koinos-scheduler` terminal:

```bash
(
set -euo pipefail
umask 077
KAI_PROVIDER_RELEASE=80eb56c94600b800c0b69910acde0937f0da052d
test "$(id -u)" = 0
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) throw Error("System Node 22 or newer required")'
KAI_PROVIDER_STAGE=$(mktemp -d /root/kai-provider-update.XXXXXXXX)
git -C "$KAI_PROVIDER_STAGE" init --quiet
git -C "$KAI_PROVIDER_STAGE" fetch --quiet --no-tags --depth=16 https://github.com/therexdev/kai.git "$KAI_PROVIDER_RELEASE" b85363e6c6188fb215e9a98fc8fdaed5869ede75
git -C "$KAI_PROVIDER_STAGE" checkout --quiet --detach "$KAI_PROVIDER_RELEASE"
cd "$KAI_PROVIDER_STAGE"
test "$(git rev-parse HEAD)" = "$KAI_PROVIDER_RELEASE"
git merge-base --is-ancestor b85363e6c6188fb215e9a98fc8fdaed5869ede75 HEAD
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=high
node deploy/koin-mainnet/update-provider-qualification.js
)
```

Success ends with **Provider qualification recovery installed and verified on loopback and HTTPS**.
An exact repeat reports that it is already installed and verified. The updater checks
its prerequisites before briefly restarting `kai-koin-prepaid.service` and restores
the previous code if health verification fails. It preserves configuration, keys,
accounts, credits, payments, reward records and qualification evidence.

Then use the current Test app and leave earning on. Qualified selected capacity can
return between checks of other models. Each model still needs its own passing
signed qualification; the app shows its actual score and available failure reasons.
No chat is needed to trigger qualification or return to qualified capacity.
