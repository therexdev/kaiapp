# Coordinated wallet flow release

This is a release candidate, not an installed update. Do not publish the desktop
candidate while the credit service lacks the matching capabilities.

Backend source: `therexdev/kai` commit
`11474a9d851769bccfb56008b2a3d4cbd6521ff3` on
`work/wallet-first-access-20261027`.

Desktop source: `work/wallet-first-purchase-20261027`, based on Test 221 and the
current Live history. The candidate verification workflow creates evidence and a
private Windows package check; it does not publish installers or update feeds.

## Release requirements

1. Pass the candidate workflow on Linux x64, Linux ARM64, macOS and Windows, including the actual
   desktop/backend integration and native credential checks. Review any skipped
   platform/hardware checks separately; fixture inference does not establish
   model quality or Pi hardware acceptance.
2. Install the exact backend revision on the existing prepaid service using
   `deploy/koin-mainnet/update-wallet-access.js` from that revision. Its documented
   preflight validates the dedicated service and preserves existing configuration,
   accounts, keys, balances, payment journals and reward policy. This requires an
   authenticated scheduler-host connection. No such connection was available in
   the implementation session.
3. Verify both public capabilities on the actual service, pinned to the packaged
   scheduler and deployment: `/auth/wallet-credit/capabilities` must report
   `walletCredits: 1` and `freeOnlySessions: 1`; and
   `/scheduler/koin/provider/device/capabilities` must report
   `walletFirstEarning: 1` and `delegatedProvider: 1`.
4. Build the exact verified source on Test, verify its installers and feed, then
   promote that source through the existing Live release procedure. A later
   concurrent Live change must be merged and verified first. Preserve the shared
   profile and separate installer/update identities.
5. Confirm an actual Windows purchase and answered network job, plus Pi wallet
   connection and device authorization, before claiming live acceptance. Tests
   use controlled chain finality, approval and inference fixtures; they do not
   transfer production KOIN or operate the owner's physical computers.

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
- The default shared model selection and any saved subset remain intact. This
  update does not approve additional model qualification policies or fund rewards.

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
