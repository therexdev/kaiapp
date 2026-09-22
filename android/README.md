# KAI Mobile 0.2.1 preview

Native Android model management, local chat, Koinos account sign-in, network chat, and account-scoped AI/mining node monitoring. Android 9+, ARM64; suited to the Retroid Pocket 5 and compatible phones/tablets.

## Mascot artwork

The in-app character and avatar reuse the exact desktop `ui/kai-robot.svg`, `ui/kai-character.css`, and `ui/assets/kai-character.png` used by the website. They are exported as transparent PNGs in the original idle pose, with the same avatar crop as `ui/brand.js`. There is no Android redraw or runtime web dependency. The previously approved launcher icon is unchanged.

To refresh the exports after the shared art changes, install the root npm dependencies and run `node android/scripts/export-mascot.cjs`. The exporter uses the pinned `sharp` dependency and its static SVG renderer. Source hashes and renderer versions are recorded in `android/mascot-source.json`.

## Install and sign in

Install `KAI-Mobile-0.2.1-ARM64-preview.apk`. This build is named **KAI** (`io.koinosai.mobile`) and installs beside the original **KAI Mobile Preview** (`io.koinosai.mobile.preview`). **0.2.1 updates the owner-signed 0.2.0 KAI app in place**, preserving accounts, chats and models. The original preview used a temporary signing key that was not retained. Android cannot install a differently signed update over it. Keeping a separate app protects the original chats and model files. Export any conversations you want from that preview; download or import models into KAI. Do not uninstall the old preview until you have saved what you need.

1. Open **Accounts → Sign in with KAI** and enable network access.
2. Open **koinosai.com/link**, sign in through the existing website, approve the displayed device code, and return to KAI. Passwords, Google sign-in and passkeys stay in the browser.
3. **Models** downloads or imports the same Fast/Balanced GGUF packages as the desktop. Download, verify and load a model.
4. Choose **Network → Local only** for on-device chat. Account refresh, downloads and remote chat are blocked in this mode. Choosing it cancels unfinished downloads. Previously completed downloads remain installed.
5. To chat remotely, select **Network** or **My node**, choose an existing account spending grant under **Accounts → Access**, and optionally select a live network model. Review and confirm each send. No grant is created or widened by Android.
6. **Accounts → AI nodes / Mining** shows the account's linked compute workers and block-producer snapshots. Refresh while network access is enabled. These are your existing nodes; the handheld does not start mining or serve earning jobs.

## Privacy and behavior

- Both local inference and network inference require a signed-in account. Models can be browsed while signed out; load, download and import operations require sign-in.
- A saved, previously verified session permits offline local use for up to 30 days, matching the website session lifetime. Reconnect to verify after expiry. A server rejection locks use until verification/sign-in succeeds. Revocations made elsewhere cannot be learned while offline.
- Sessions and the associated account profile are encrypted with an AES-GCM key in Android Keystore. There is no plaintext credential fallback. Account files live in `noBackupFilesDir`; Android backup and device transfer are disabled for app data.
- Local conversations are stored only on this device and partitioned by account. Sign-out hides them and locks both inference paths. Signing back into that account restores access. Explicit export is available in Chat → Chats.
- Switching chat mode opens an empty conversation. Local history is never silently uploaded. My Node sets the server's `selfHost` flag and never falls back to paid providers. Its grant selects the wallet/node, just as on the website.
- Remote chat uses the existing session-and-grant scheduler contract, with server-side cap/expiry enforcement, cancellation, bounded SSE parsing, partial-reply preservation, and reported final cost. Remote conversations are saved locally; they are not synchronized into the website's chat list.
- Network access is off by default. The selected mode is remembered. Local only makes no account/scheduler requests. Opening a website link is an explicit external-browser action. Sign-out attempts server revocation only if network access was enabled when requested, then removes the local credential even if revocation fails.
- Node cards show a timestamped snapshot. Refresh failures retain the last snapshot and show an error; they do not replace it with a misleading empty/healthy state. Mining estimates are the existing node's reported estimates, with measured-history and stale-price flags preserved.
- No wallet keys, wallet transfers, node control, phone mining, voice, desktop tools, or automatic local/network fallback are included.

## Local model engine

Pinned llama.cpp revision `ec5a12b85ae32fbccfa4276051382330a8e6458b`, CPU-only ARMv8-A compatibility baseline, 16 KB native page alignment. Koinos Fast and Balanced use the exact desktop catalog sizes/hashes; imports are bounded, verified GGUF files copied from a document picker. No model weights are bundled. Models never autoload. Generation stops when the app leaves the foreground; Android can continue explicitly authorized downloads when Network is enabled.

## Build and signing

JDK 17, SDK/build tools 35, NDK 27.2.12479018, CMake 3.22.1, Gradle 8.9, AGP 8.7.3:

```sh
git submodule update --init android/vendor/llama.cpp
cd android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

The delivered APK is a non-debuggable release build signed with a retained owner key. Its private signing recovery bundle is kept separately from Git. To produce compatible updates, restore that key and point `KAI_SIGNING_PROPERTIES` at a private Java properties file with `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`, then run `:app:assembleRelease`. Never commit the key, passwords, or properties file. Increment `versionCode` for every delivered update. CI debug APKs use the CI debug signer and cannot update the owner-signed installation.

Default ABI: ARM64. Pass `-PkaiAbi=x86_64` for an emulator. Output: `app/build/outputs/apk/release/app-release.apk`. Without owner signing configuration, the release is unsigned.

## Service contracts and verification

Uses the existing public website source in `therexdev/kai`: device start/poll, bearer `/auth/session`, bearer `/account/api/nodes`, `/scheduler/network/models`, and `/scheduler/consume/chat/completions` with `sessionToken`, `grantId`, `selfHost`, and server SSE frames. All app requests use the fixed HTTPS origin `https://koinosai.com`; redirects are not followed and credentials are never put in URLs. No website deployment is needed.

Tests cover authentication gates, device linking, expiry/rejection, account separation, Local-only egress blocking, full-chat-limit route isolation, grants, own-node routing, interrupted streams, file verification, and navigation. `VisualPreviewTest` renders the actual Android layouts in portrait and handheld landscape using Robolectric native graphics. Its account data is explicitly synthetic. See `VALIDATION.md` for tested scope and remaining physical-device checks.
