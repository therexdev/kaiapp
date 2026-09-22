# KAI Mobile 0.3.2 preview

Native Android model management, local and network chat, offline voice recognition, spoken conversations, optional web search, Koinos account sign-in, and account-scoped AI/mining node monitoring. Android 9+, ARM64; suited to the Retroid Pocket 5 and compatible phones/tablets.

## Mascot artwork

The in-app character and avatar reuse the exact desktop `ui/kai-robot.svg`, `ui/kai-character.css`, and `ui/assets/kai-character.png` used by the website. They are exported as transparent PNGs in the original idle pose, with the same avatar crop as `ui/brand.js`. There is no Android redraw or runtime web dependency. The previously approved launcher icon is unchanged.

To refresh the exports after the shared art changes, install the root npm dependencies and run `node android/scripts/export-mascot.cjs`. The exporter uses the pinned `sharp` dependency and its static SVG renderer. Source hashes and renderer versions are recorded in `android/mascot-source.json`.

## Install and sign in

Install `KAI-Mobile-0.3.2-ARM64-preview.apk`. This build is named **KAI** (`io.koinosai.mobile`) and installs beside the original **KAI Mobile Preview** (`io.koinosai.mobile.preview`). **0.3.2 updates the owner-signed 0.2.x / 0.3.x KAI app in place**, preserving accounts, chats and models. The original preview used a temporary signing key that was not retained. Android cannot install a differently signed update over it. Keeping a separate app protects the original chats and model files. Export any conversations you want from that preview; download or import models into KAI. Do not uninstall the old preview until you have saved what you need.

1. Open **Accounts → Sign in with KAI** and enable network access.
2. Open **koinosai.com/link**, sign in through the existing website, approve the displayed device code, and return to KAI. Passwords, Google sign-in and passkeys stay in the browser.
3. **Models** downloads or imports the same Fast/Balanced GGUF packages as the desktop. Download, verify and load a model.
4. Choose **Network → Local** for on-device chat. You stay signed in, and account updates and model downloads remain available while online. Switch freely between **Local**, **Network**, and **My node** without disconnecting or cancelling downloads. A loaded local model stays loaded.
5. To chat remotely, select **Network** or **My node**, choose an existing account spending grant under **Accounts → Access**, and optionally select a live network model. Review and confirm each typed send; voice chat authorizes spoken follow-ups for the current foreground session. No grant is created or widened by Android.
6. **Accounts → AI nodes / Mining** shows the account's linked compute workers and block-producer snapshots. Refresh while network access is enabled. These are your existing nodes; the handheld does not start mining or serve earning jobs.

7. **Settings → Offline mode** is a separate choice that stops account/network requests and cancels unfinished downloads while keeping your saved sign-in. Turn it off to reconnect without changing the selected model. A fresh install starts offline until sign-in or an explicit Go online action. Upgrades preserve the previous Local-only privacy setting.

## Compact chat layout

Chats is in the top bar beside the model route. Conversation information scrolls with the messages, leaving the composer pinned above navigation. The composer has a voice picker inside the text bubble, a Web globe and a send arrow. All icon actions retain 48 dp touch targets, accessibility labels and long-press tooltips. The send arrow becomes Stop during a reply.

Portrait and landscape share this compact layout. While the chat keyboard is open, app navigation hides and the composer stays above the keyboard; navigation returns when it closes. Short windows limit the visible draft to one or two scrolling lines. Landscape keyboards are asked to keep the app visible instead of taking over the screen. Routine model/voice-ready status rows are removed; active voice/download progress stays inside the bubble, and model loading appears in the conversation.

## Voice and web search

- In **Settings → Voice & spoken replies**, download the optional **41 MB English voice pack**. It is pinned by size and SHA-256, verified before installation, and works offline afterward. Setup needs 160 MB free. Downloading follows the Wi-Fi-only preference and never changes the selected model route.
- Voice-pack download percentage and installation status appear inside the message bubble. Completion shows a brief **Voice input is ready** notice; Settings retains the installed status.
- Tap the **voice icon → Dictate message** to transcribe locally into the composer so you can review and send. Grant microphone permission when prompted. Handhelds without a microphone need a connected headset or microphone.
- Send stays available when no local model is loaded. It offers **Load & send** for installed models and keeps the draft intact. Voice chat similarly offers **Load & start voice**. Leaving Chat, backgrounding or stopping the load cancels that continuation. If no model is installed, the dialog opens Models; the voice-recognition pack and the AI reply model are separate downloads.
- **Voice icon → Voice chat** starts a visible, foreground conversation: listen, automatically send the recognized question to the selected model, speak the reply, then listen for a follow-up. The microphone pauses during playback. The active voice icon / **Stop**, leaving Chat, leaving the app, a route/account/grant change, or 60 seconds without a recognized question ends the session. There is no background wake word or spoken interruption in this version.
- **Read replies aloud** also speaks typed replies. Playback uses an installed **offline English Android TTS voice**, with Bright, Natural and Lower pitch options. Open **Android voice settings** to install/configure a voice if needed. It does not include desktop Azelma/Pocket TTS and never falls back to a network speech engine. Audio is not saved or uploaded; recognized text follows your selected chat route.
- The **Web globe** is off by default and turns blue when enabled. Enabling it discloses that each question's first 400 characters go to DuckDuckGo HTML search, with Bing RSS as a fallback. Earlier chat history and account credentials are not sent to search providers. Query terms appear in the provider's HTTPS request URL and are subject to that provider's handling.
- Search shows the submitted question and actual search provider, then a **Thinking…** / **Writing answer…** card with the domains whose snippets were supplied. It does not simulate reading full pages or rotate invented browsing steps. The answer appears as the model generates it.
- Search snippets are passed to the selected model as untrusted evidence, with numbered source links and retrieval time saved in the chat. Finished answers put details behind a collapsed **Sources** button: expand it to see the query, provider, retrieval time, links and exact snippets supplied to KAI. KAI does not automatically open or fetch result pages. Sources are search snippets, not verified full-page reading; small local models can still misinterpret evidence. Obviously unrelated results are filtered. If search is blocked or finds no usable result, KAI shows an error and restores the question instead of silently answering from old model knowledge.
- Web works with **Local**, **Network**, or **My node** while network access is enabled. Local inference stays on the device; the explicit Web option still sends the current search query to its providers. **Offline mode** blocks search. If Web is still selected, **Continue offline** turns Web off while preserving Local and your sign-in; **Use web search** enables connectivity while keeping Local selected.
- Voice chat confirms the chosen route, selected spending grant and Web setting at session start. Spoken follow-ups may spend from the grant, with server cap/expiry enforcement. Changing that scope ends the session; it must be explicitly started again.

## Privacy and behavior

- Both local inference and network inference require a signed-in account. Models can be browsed while signed out; load, download and import operations require sign-in.
- A saved, previously verified session permits offline local use for up to 30 days, matching the website session lifetime. Reconnect to verify after expiry. A server rejection locks use until verification/sign-in succeeds. Revocations made elsewhere cannot be learned while offline.
- Sessions and the associated account profile are encrypted with an AES-GCM key in Android Keystore. There is no plaintext credential fallback. Account files live in `noBackupFilesDir`; Android backup and device transfer are disabled for app data.
- Local conversations are stored only on this device and partitioned by account. Sign-out hides them and locks both inference paths. Signing back into that account restores access. Explicit export is available in Chat → Chats.
- Switching chat mode opens an empty conversation. Local history is never silently uploaded. My Node sets the server's `selfHost` flag and never falls back to paid providers. Its grant selects the wallet/node, just as on the website.
- Remote chat uses the existing session-and-grant scheduler contract, with server-side cap/expiry enforcement, cancellation, bounded SSE parsing, partial-reply preservation, and reported final cost. Remote conversations are saved locally; they are not synchronized into the website's chat list.
- Model choice and network permission are saved independently. Local inference stays on the device. With Web off, local chat text is not sent online; Web on explicitly sends the current query to search providers. Offline mode makes no account/scheduler requests. Signing in, refreshing an account, or downloading a model does not change the selected model route. Opening a website link is an explicit external-browser action. Sign-out attempts server revocation only if network access was enabled when requested, then removes the local credential even if revocation fails.
- Node cards show a timestamped snapshot. Refresh failures retain the last snapshot and show an error; they do not replace it with a misleading empty/healthy state. Mining estimates are the existing node's reported estimates, with measured-history and stale-price flags preserved.
- No wallet keys, wallet transfers, node control, phone mining, desktop tools, or automatic local/network fallback are included.

## Local model engine

Pinned llama.cpp revision `ec5a12b85ae32fbccfa4276051382330a8e6458b`, CPU-only ARMv8-A compatibility baseline, 16 KB native page alignment. Koinos Fast and Balanced use the exact desktop catalog sizes/hashes; imports are bounded, verified GGUF files copied from a document picker. No model weights are bundled. Models never autoload. Generation stops when the app leaves the foreground; Android can continue explicitly authorized downloads while online, including when Local is selected.

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

Uses the existing public website source in `therexdev/kai`: device start/poll, bearer `/auth/session`, bearer `/account/api/nodes`, `/scheduler/network/models`, and `/scheduler/consume/chat/completions` with `sessionToken`, `grantId`, `selfHost`, and server SSE frames. Account/scheduler requests use the fixed HTTPS origin `https://koinosai.com`; redirects are not followed and credentials are never put in URLs. Search uses fixed HTTPS DuckDuckGo/Bing endpoints, without account credentials or redirect following. The optional voice pack downloads from Alpha Cephei through Android DownloadManager and is checked against its pinned hash. No website deployment is needed.

Tests also cover voice turn sequencing, Stop and late callbacks, offline TTS voice selection, speech-pack integrity/path traversal, bounded search parsing, relevance filtering, provider fallback, search cancellation and source persistence. Tests cover authentication gates, device linking, expiry/rejection, account separation, independent route/connectivity persistence, switching without sign-out or download cancellation, Offline-mode egress blocking, full-chat-limit route isolation, grants, own-node routing, interrupted streams, file verification, and navigation. `VisualPreviewTest` renders the actual Android layouts in portrait and handheld landscape using Robolectric native graphics. Its account data is explicitly synthetic. See `VALIDATION.md` for tested scope and remaining physical-device checks.
