# Android 0.3.0 voice and web preview — 2026-09-22

- Passed `:app:testDebugUnitTest :app:lintDebug :app:assembleRelease`: **56 tests**, no failures or lint errors. Coverage includes 19 account/route/search contract tests, seven startup/lifecycle tests, six model-file tests, four network-stream tests, eight voice-controller tests, five search tests, four speech-pack tests, one Android offline-voice selection test and two actual-layout rendering tests.
- Voice tests verify dictation versus automatic submission, microphone pause during speech, streamed sentence ordering, follow-up only after playback, foreground/tab loss, Stop and stale callbacks, timeout, missing offline TTS voice, and offline dictation with Web selected. The real Android microphone and TTS device services still require physical-device validation.
- Downloaded the official 41,205,931-byte Vosk English pack and installed it through the same Java integrity/extraction code. SHA-256 matched `30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498`; required model/config files and the verification marker were produced. Negative tests cover incorrect size, a same-size incorrect hash, and ZIP path traversal.
- Ran the actual Java HTTPS search transport against public providers. DuckDuckGo returned an automated-client challenge; Bing returned a four-source Retroid search result. Other live Bing queries returned unrelated results, which motivated a conservative query-term relevance filter and explicit failure handling. The stored unrelated response is rejected by the updated parser. This is a keyless preview search integration: provider availability, relevance, freshness and full-page accuracy are not guaranteed. No CAPTCHA bypass, user login, account credentials or paid requests were used.
- Web tests verify fixed bounded requests, fallback, Stop without a later generation, Offline blocking, query-only disclosure, unsafe-link filtering, non-fetching XML parsing, unrelated-result rejection, persisted source metadata and model context that treats snippets as untrusted evidence. Search does not execute model-proposed actions or fetch arbitrary result pages.
- Reviewed native Android portrait layouts for chat controls, source cards and voice settings, plus existing handheld landscape layouts. Source/account screenshot data is explicitly synthetic. These are Robolectric native graphics renders, not installed-device screenshots.
- Verified non-debuggable ARM64 package `io.koinosai.mobile`, version code **5**, version **0.3.0-preview**, 16 KB APK ZIP alignment and ELF segment alignment for llama.cpp, Vosk and JNA. Signing certificate remains `c956b88ac520cab5b5ea93fd29c18ee032522e512e6a5a1378fe66a40f0c394b`, permitting an in-place update over owner-signed 0.2.x without clearing app data.
- Delivered APK: **17,447,688 bytes**, SHA-256 `7c10285dae370b65bb836a0c1bc22729ed6646763c9aae3f4895e20c56f7e3eb`.
- Remaining device checks: microphone permission and headset recognition on the Pocket 5, offline English Android voice availability, speaker echo/latency, interruption/background cleanup on real audio hardware, in-place installation, and end-to-end local/network/own-node voice replies. No physical-device voice quality, real account login or paid generation test is claimed. Desktop source, website services, original mascot/launcher and the native inference engine are unchanged.

# Android 0.2.2 independent model selection — 2026-09-22

- Model route (Local / Network / My node) and network permission now persist independently. Switching routes does not cancel account requests, sign-in, model downloads, or unload the local model. Offline mode is a separate Settings control; upgrading preserves the prior privacy choice.
- Passed the complete 33-test Android suite: 16 account/route tests, five startup/UI tests, six file-integrity tests, four network-stream tests and two native-layout rendering tests. New coverage exercises online Local account refresh/downloads without changing route, local prompt isolation while online, session/download/model/grant retention across all routes, device-link continuity, preference/session restoration, legacy privacy migration, signed-out gates, and explicit Offline cancellation without stopping local generation. UI tests check switches without a disconnect dialog and Offline confirmation/cancel behavior.
- Passed `:app:testDebugUnitTest :app:lintDebug :app:assembleRelease`. Lint has no errors. Reviewed native Android portrait and handheld renders, including model choices, the separate Offline setting, and signed-in account details with Local selected.
- Verified the non-debuggable ARM64 release, package `io.koinosai.mobile`, version code 4 / `0.2.2-preview`, 16 KB ZIP alignment, and unchanged retained owner signing certificate. Installs over owner-signed 0.2.0 / 0.2.1 without clearing app data.
- Delivered APK SHA-256: `4126c86468f27f7c154fd6e22216198fbeee32066ef4fe8556a9175f2dc0f6e7`.
- Account tests use a fake transport, session vault and Android download service; no real login, paid generation or physical-device update is claimed. The native inference engine, original mascot exports, launcher and website services are unchanged.

# Android 0.2.1 mascot correction — 2026-09-22

- Replaced the in-app vector redraw with direct static exports of the original desktop SVG, stylesheet, and texture. The source artwork matches the latest Test branch inspected (`6d51341`); hashes and renderer versions are in `mascot-source.json`.
- Reviewed actual Android portrait (411 × 891) and handheld landscape (960 × 540) renders, including the welcome mascot, header/avatar, account fixture, and launcher. The launcher source files are unchanged from 0.2.0. Screenshots use Robolectric native graphics, not a physical device.
- Passed `:app:assembleRelease`, the two existing `VisualPreviewTest` rendering tests, and `:app:lintDebug` (no errors). Cleared stale local Gradle output/metadata to resolve duplicate generated R classes before the successful build. No new functional tests were added or claimed for this artwork-only revision.
- Verified non-debuggable ARM64 package `io.koinosai.mobile`, version code 3 / `0.2.1-preview`, 16 KB ZIP alignment, and the same retained owner signing certificate as 0.2.0. This permits an in-place update; no data migration or account/network/inference behavior changed.
- Delivered APK SHA-256: `623abf5f420571350c611a094d9d66a6373de3f7e15066527bbdcc3da4ab8eaf`.

The prior functional validation and physical-device limitations below still apply.

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
