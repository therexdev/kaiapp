# Android 0.2 validation — 2026-09-22

## Passed

- Non-debuggable, ARM64 release APK build with the retained owner signing key; local Gradle unit-test and Android lint gates.
- 23 Android tests: six file-integrity/import tests, eight account/route contract tests, four network-stream tests, three startup/navigation tests, and two actual-layout rendering tests.
- Device-link request/response contract, saved session, expired/rejected session gates, retry after expired link code, sign-out, account separation, Local-only request blocking, empty conversation on route changes including the 30-chat limit, explicit grant and own-node request shape, partial-response preservation, bounded/Unicode/multiline SSE handling.
- Native Android layout render review at 411 × 891 portrait and 960 × 540 handheld landscape, including the adaptive launcher icon, sign-in, model library, account overview/mining fixtures, mode selection, and settings. Account screenshots contain synthetic data only.
- Catalog check: both Android packages match the desktop model identity, byte size and SHA-256.
- APK signature and 16 KB ZIP/native-library alignment checks. Manifest inspected for the application ID, version, ARM64 ABI and disabled debugging.
- Live, unauthenticated read-only checks: `/auth/session` and `/account/api/nodes` returned 401; `/scheduler/network/models` returned a live model/price catalog. No user credentials were used and no paid request was submitted.
- Website API contracts inspected in `therexdev/kai` commit `13a7ba436a67a6442f0311f065898b744538f71f`; Android changes are based on the existing Android branch and the latest Test base `125182907e9aa9b4d4275df3634d7921f9a59fe4`.
- No desktop application source, dependencies, wallet, mining, or server code changed. No service deployment is required.

Lint has no errors; remaining warnings concern optional ChromeOS ABI coverage, storage-space APIs, English strings, and unused small vector resources. These are not runtime or signing failures.

## Scope and remaining device checks

The user confirmed the original 0.1 local-model APK works on their device. The native inference implementation and pinned llama.cpp revision are unchanged in 0.2. The earlier native smoke tests passed, but were not rerun as part of this UI/account revision.

Robolectric rendering is actual Android View rendering, not an installed emulator or physical device. A real website account sign-in, Android Keystore round trip, account-node refresh and remote/own-node inference must still be exercised on the Pocket 5. No end-to-end account login or paid generation is claimed. Check return from browser sign-in, cached-session airplane mode, model downloads, Stop, portrait/landscape and controller focus on the device.

The delivered package installs as **KAI** beside the original **KAI Mobile Preview** because that initial preview's temporary signing key is unavailable. The new owner signing material is retained separately so subsequent delivered APKs can update this installation. CI debug APKs are signed differently and are only for development.
