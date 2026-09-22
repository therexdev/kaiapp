# KAI Mobile Preview

Native Android model manager and offline text chat, designed for Android gaming handhelds such as the Retroid Pocket 5 and compatible phones/tablets.

## Install and try

1. Install the ARM64 preview APK on Android 9 or newer. Android may ask you to allow installation from the app you used to download it.
2. Open **Models → Koinos Fast → Download**. Downloads use Wi-Fi by default and continue through Android's download manager.
3. Wait for the download and SHA-256 integrity check, then tap **Load model**.
4. Open **Chat** and send a message. Once the model is downloaded, generation works without an internet connection.
5. **Stop** cancels loading or generation. **Unload** releases the model's memory. **Delete** removes its downloaded file.

The Pocket 5 starting profile is Koinos Fast (Qwen 2.5 1.5B Q4_K_M), 2,048 context tokens, four CPU threads, and 384 reply tokens. Koinos Balanced (Llama 3.2 3B Q4_K_M) is also included. These are the existing desktop catalog packages with the same expected sizes and hashes. Pocket 5 performance and battery use must be measured on physical hardware; no device-specific latency is promised.

## Included

- Explicit, opt-in model downloads with Android download notifications, progress, retry and cancel.
- Complete size/hash verification before installation and again before each model load.
- Single-file text GGUF import via Android's document picker (including SD cards). Imports are copied into app-specific storage, bounded by available storage/device memory, and fingerprinted; this does not certify their origin or guarantee architecture compatibility.
- CPU inference using a pinned llama.cpp revision, compiled into the APK. No terminal, separate server, cloud API or login is needed.
- Streamed responses, cancellation during prefill/generation, bounded context, whole-turn history trimming with a visible notice, and preservation of partial responses.
- Up to 30 saved conversations, new/select/delete controls, and user-selected plain-text export.
- Context, thread count, reply length, temperature, system instructions, Wi-Fi preference and memory/storage information.
- Touch/controller-focusable native controls, portrait/landscape layout, selectable message text, and offline open-source notices.

Model-proposed actions are never executed. This preview has no tools, wallet, remote inference, earning, microphone, vision or desktop synchronization. It does not modify the desktop application, its profile or release version. Model and chat data are removed if the app is uninstalled or its storage is cleared. Conversation export is explicit; automatic Android backup is disabled.

Generation stops when the app leaves the foreground. Downloads can continue in the background. A downloaded model is never loaded automatically at launch.

## Build

Requirements: JDK 17, Android SDK 35, NDK 27.2.12479018, CMake 3.22.1. The Gradle wrapper uses Gradle 8.9 and Android Gradle Plugin 8.7.3.

```sh
git submodule update --init android/vendor/llama.cpp
cd android
# Set ANDROID_HOME, or create local.properties containing sdk.dir=/path/to/sdk
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`. The application ID is `io.koinosai.mobile.preview` and it is signed with the developer's Android debug key. This is a sideloadable testing build, not a production release. Rebuilds require the same signing key to install as updates; production signing and an update channel must be established before public distribution. Never commit private signing keys.

For an x86_64 emulator build, pass `-PkaiAbi=x86_64`. The normal distributable targets only ARM64. 16 KB native page alignment is enabled. CPU-only ARMv8-A is the compatibility baseline; this preview does not claim GPU or NPU acceleration.

The native dependency is pinned by Git submodule to `ec5a12b85ae32fbccfa4276051382330a8e6458b`. When updating it, verify native API changes, the model-template path, cancellation and both ABI builds. Catalog integrity is verified by `python3 scripts/check-catalog.py` from this directory.

## Verification

`ModelFileTest` covers complete/corrupt/incomplete downloads, HTML instead of GGUF, cancellation, storage limits and partial-file cleanup. The native smoke executable loads an actual small model and checks generation, stop, history trimming, oversized prompts and unload/reload:

```sh
cmake -S app/src/main/cpp -B build-host -DCMAKE_BUILD_TYPE=Release
cmake --build build-host -j4
./build-host/kai-engine-smoke /path/to/SmolLM2-135M-Instruct-Q8_0.gguf
```

Before promoting a production build, test Koinos Fast and Balanced on a real Pocket 5: download interruption, process restart, airplane-mode chat, Stop, model switching, full storage, low memory, export, portrait/landscape, background/foreground, controller navigation, thermals and battery life. The tiny native smoke model is for runtime testing, not evidence of assistant quality.
