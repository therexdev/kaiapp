# Update wallet access, earning and KOIN purchases

This is the coordinated Test update for the wallet-first handoff and the related
purchase, pricing, wallet-history, model-selection and Linux restart changes.
The operator's rollout is **update Vultr → update Koinos AI Test → test**.
Publishing the app does not install the credit service or establish live payment
or reward success. Keep Live promotion separate until Test acceptance succeeds.

Backend source: `therexdev/kai` commit
`a8edc3bd6d21c40cebe175f7ead36844900b2b7c` on
`work/wallet-first-access-20261027`.

Desktop source starts from Test 221 and current Live history. The Test workflow
stamps the next patch version as `0.54.13-test.<run>.<attempt>` and publishes only
after its Windows, Linux x64, native Linux ARM64 and macOS checks pass. Windows
and Linux installers remain on the separate Test update channel; macOS receives
source verification here, not a new Test installer.

## 1. Update Vultr

From Windows PowerShell, connect to your existing Vultr server:

```powershell
ssh root@45.76.255.224
```

At the `root@koinos-scheduler` prompt, paste this complete block:

```bash
(
set -euo pipefail
umask 077
KAI_RELEASE_COMMIT=a8edc3bd6d21c40cebe175f7ead36844900b2b7c
test "$(id -u)" = 0
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) throw Error("System Node 22 or newer required")'
KAI_UPDATE_STAGE=$(mktemp -d /root/kai-wallet-update.XXXXXXXX)
git -C "$KAI_UPDATE_STAGE" init --quiet
git -C "$KAI_UPDATE_STAGE" fetch --quiet --no-tags --depth=64 https://github.com/therexdev/kai.git "$KAI_RELEASE_COMMIT" 9d4ad205cf06fe54cc1a38f7088e87443eb7e87b
git -C "$KAI_UPDATE_STAGE" checkout --quiet --detach "$KAI_RELEASE_COMMIT"
cd "$KAI_UPDATE_STAGE"
test "$(git rev-parse HEAD)" = "$KAI_RELEASE_COMMIT"
git merge-base --is-ancestor 9d4ad205cf06fe54cc1a38f7088e87443eb7e87b HEAD
npm ci --ignore-scripts
npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
node deploy/koin-mainnet/update-wallet-access.js
)
```

This uses a fresh staging directory and leaves earlier bootstrap keys intact.
No password or wallet key belongs in the command block.

The updater checks the dedicated prepaid service before changing it. It retains
accounts, credit balances, private keys, payment journals, existing Smart
qualification and reward economics. It adds the reviewed qualification criteria
for the remaining pinned catalog models; other runtime settings remain intact. It verifies loopback and public HTTPS health plus both required
capabilities against the configured mainnet deployment:

- `/auth/wallet-credit/capabilities`: `walletCredits: 1`, `freeOnlySessions: 1`.
- `/scheduler/koin/provider/device/capabilities`: `walletFirstEarning: 1`,
  `delegatedProvider: 1`.

Continue to the app update only after the server command reports success. A
failed command retains its diagnostic and stops; a deployment failure restores
the previous code while keeping newly written account/payment records.

## 2. Update the app

Open the Test app's normal update control and install the release newer than
`0.54.12-test.221.1`. Alternatively use the current Windows Setup or matching Linux
AppImage from the [Test release page](https://github.com/therexdev/kaiapp/releases/tag/test-build).
Quit any running Live/Test instance through its tray before opening the updated
app. Existing wallets, models, chats, node paths and balances stay in the shared
profile; Test keeps its separate installer and update feed.

On Linux/Pi, run the updated AppImage once. It creates the menu and desktop
launcher and updates its own target on later AppImage launches. A desktop may
require its normal **Allow Launching** action. Do not run both Live and Test
against the shared profile.

## 3. Test the complete flow

- **Provider:** open Earn. Use the existing wallet or create/import one through
  the normal wallet screen. **Enable earning** asks for one native wallet review
  authorizing this computer; no email/password account or buyer balance is
  required. Start earning, wait for verified ONLINE, then lock the wallet.
  Qualified assigned work continues using the non-spending device credential.
- **Buyer:** open Credits and **Connect wallet**. Review the wallet connection
  inside the app; separate email/password signup is optional. Enter dollars to
  see the automatically refreshed KOIN estimate and model pricing, then Buy and
  approve the exact payment. The balance updates after confirmation. Select
  Network in Chat and send a message using an available qualified model.
- **Credit priority:** free credits are used first by default. Settings contains
  **Use paid credits before free credits when using the network** when the service
  supports it. The app displays the service's actual free allowance.
- **Pi without a protected keyring:** choose the explicit session-only connection
  for free-credit access or temporary earning authorization. This lasts until
  the app quits. Persistent buying requires protected credential storage.
- **Models:** Earn defaults to all compatible installed models and preserves an
  explicitly selected subset. Starting earning automatically loads each selected
  model for fresh qualification; no chat is required. The service accepts the 15
  exact catalog packages under the same 12-of-12 correct signed-answer criteria,
  with a 30-second limit per answer and one-day qualification validity. A separate
  120-second preparation window lets the model load before timed checks begin.
  Passing models can then load on demand for assigned requests. Readiness remains
  individual to each model; installation alone does not qualify it, and the app
  does not keep every model loaded simultaneously.
- **Wallet:** check KOIN, VHP and Mana plus transaction history. Those remain
  readable while the spending wallet is locked.

A confirmed purchase, answered network request, actual provider work with the
wallet locked and behavior on the user's Pi are live acceptance observations.
Automated checks do not substitute for them. Reward distribution additionally
requires the server's configured reward cycle and funded wallets; an ONLINE
indicator alone is not proof of a payout.

## Release evidence and operator boundary

The code is tested together using the pinned backend. Native Windows checks use
the packaged app, real OS-encrypted credentials and SQLite recovery, including
long Windows paths. Native ARM64 checks use real Electron/Secret Service and
exercise secure and temporary sessions. Tests use controlled chain finality,
approval and inference rather than production transfers or the owner's keys.

The operator runs the Vultr update because the implementation session has no
authenticated scheduler shell. This is an installation step with a pinned
updater, not a request to diagnose or patch the service by hand. Record its
success and the Test installer version before live acceptance. Promote the exact
accepted source through the existing Live procedure, incorporating and checking
any intervening Live changes first.

## Preserved behavior

- Existing account sign-in remains available. Wallet proof resolves the existing
  wallet's internal account identity and never silently merges accounts.
- Service policy remains authoritative for free credits; device creation cannot
  create extra grants or multiply a wallet's effective reward capacity.
- Payment records and exact signed transaction recovery remain intact. Buyer
  purchases still require native approval and the unlocked payment wallet.
- Provider device authority has no spending power. Earning with the reward wallet
  locked still requires fresh model qualification and network confirmation.
- Missing Linux keyring support is distinct from a missing account. Explicit
  temporary access is memory-only and free-only for buying-side chat; persistent
  purchases require protected storage. Temporary sign-out preserves any hidden
  older encrypted credential in an archive without automatically reactivating it.
- The default shared model selection and any saved subset remain intact. The
  existing Smart policy is preserved while the same objective qualification
  criteria extend to all pinned catalog models. No prior pass or quality result
  is assumed for another model or provider.
- On-demand availability requires the worker's signed support and each model's
  fresh qualification. Availability rewards count the actual loaded capacity;
  dormant installed models do not multiply that capacity. Existing free-credit
  grants, payout rates, wallet funding and contract deployment remain unchanged.

The separate Master producer application does not contain this prepaid stack;
its producer custody, distribution configuration and profile were not changed.

## Native ARM64 verification scope

The candidate workflow uses `ubuntu-24.04-arm` to execute ARM64 Electron directly.
It checks the Linux launcher and shared-profile relaunch, builds an ARM64 Test
AppImage without publishing it, verifies its packaged content and ELF architecture,
and exercises the packaged wallet/device code in a disposable D-Bus session.
A generated test keyring verifies native `gnome_libsecret` encryption across
process restart with the payment wallet locked. A separate `basic_text` profile
must refuse persistence, allow only explicitly approved temporary access, and
retain no session or device secret after restart. No real accounts, keys, service
requests or production transactions participate in this fixture.

These checks establish Ubuntu ARM64 compatibility. They do not establish physical
Raspberry Pi performance, Raspberry Pi OS/Wayland desktop integration, model
inference quality or the user's installed keyring state. Candidate artifacts
contain evidence only; AppImages and update feeds are not published by this job.
