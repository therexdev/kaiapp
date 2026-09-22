# Preview validation — 2026-09-22

Validated locally with JDK 17, SDK 35, NDK 27.2.12479018 and the pinned llama.cpp revision.

| Check | Result |
| --- | --- |
| ARM64 APK assembly | Passed |
| Android model file tests | 6 passed |
| Android startup/navigation/conversation tests (Robolectric, API 28) | 2 passed |
| Android lint | No errors; non-blocking compatibility, storage and localization warnings |
| APK signature verification | Passed, Android debug signer, v2 signature |
| APK ZIP alignment and native ELF 16 KB page alignment | Passed |
| Android catalog vs desktop pinned model identities | Both packages match |
| Native generation with SmolLM2 135M Q8_0 on the build host | Passed; generated a real response |
| Native cancellation, context trimming, oversized prompt rejection, unload/reload | Passed |
| x86_64 emulator APK assembly | Passed |
| Full Android emulator smoke test | Not completed: emulator System UI/package services became unresponsive without hardware acceleration |
| Physical Retroid Pocket 5 | Not available; performance, battery and full download/inference flow remain to be tested |

The broader desktop `npm test` attempt produced 769 passing test lines and six failing test lines in the unchanged Smart-Turn cache/node-folder tests before it was stopped. Desktop source and dependencies were not changed. Those results are not treated as a passing desktop release gate; this preview is isolated on its Android feature branch.

The APK is an initial testing build with its own app ID (`io.koinosai.mobile.preview`). It is not a production Android release or evidence of desktop feature parity. A production signing key and update channel must be configured before wider release. The native test does not measure Pocket 5 inference speed, and the tiny smoke model is not part of the user-facing model catalog.
