# macOS build and release guide

Koinos AI can be packaged for both current Mac architectures:

| Architecture | Package suffix | Intended machines | Validation status |
|---|---|---|---|
| `arm64` | `-arm64` | Apple Silicon | Compiled and smoke-tested on a physical M4 Mac |
| `x64` | `-x64` | Intel Macs | Cross-compiled on Apple Silicon and executable inspected; the pinned llama.cpp runtime was exercised under Rosetta. A physical Intel smoke test is still required before declaring full support. |

The minimum deployment target is macOS 12.0 while this project remains on Electron 43. Both a DMG and ZIP are generated. The ZIP and `latest-mac.yml` are required by `electron-updater`; do not publish the DMG alone.

## Local unsigned build

Requirements:

- macOS 12 or newer;
- Node.js 22 (the CI baseline) and npm;
- Xcode Command Line Tools;
- enough free disk space for two Electron packages.

From a clean checkout:

```bash
npm ci
npm test
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

Setting `CSC_IDENTITY_AUTO_DISCOVERY=false` is important for reproducible developer builds: it prevents electron-builder from silently selecting a certificate from the local keychain. Outputs are written to `dist/` and include:

- `koinos-ai-<version>-arm64.dmg` and `.zip`;
- `koinos-ai-<version>-x64.dmg` and `.zip`;
- blockmaps and `latest-mac.yml` for update delivery.

Inspect the application executables after packaging:

```bash
file "dist/mac-arm64/Koinos AI.app/Contents/MacOS/Koinos AI"
file "dist/mac/Koinos AI.app/Contents/MacOS/Koinos AI"
```

The first must report `arm64`; the second must report `x86_64`.

## Runtime behavior

The runtime catalog pins the official llama.cpp `b10423` macOS archives by URL, byte size, and SHA-256 for both architectures. Apple Silicon tries the Metal-capable runtime first and falls back to CPU execution with GPU layers disabled if startup fails. The official Intel archive is CPU-only, so Intel Macs do not enter a misleading Metal rung. Adjacent `.dylib` files resolve through `DYLD_LIBRARY_PATH` scoped only to the child process.

Managed Node.js packages are also pinned for both Darwin architectures, so MCP tools do not require a separate system Node installation.

The managed Koinos node uses the same official Compose template and image tags as the other platforms, with one macOS-specific materialization step. Docker Desktop rejects file-backed Compose `configs` whose targets sit inside the separately bind-mounted `/koinos` tree. On macOS, Core therefore copies `config.yml`, `genesis_data.json`, and `koinos_descriptors.pb` into their normal paths under `BASEDIR` and removes only those nested config mounts from the generated Compose file. Linux and Windows keep the upstream-shaped Compose configuration unchanged.

Mainnet JSON-RPC is exposed on `127.0.0.1:8085`, matching the current `koinos/koinos` example and avoiding the commonly occupied development port `8080`. The service still listens on port `8080` inside its container. Node startup requires Docker Desktop and sufficient disk for chain data; the application does not enable block production or register a signing key unless the user separately opts in.

Voice transcription remains gracefully unavailable on macOS because upstream whisper.cpp `v1.9.2` does not publish the CLI archive that this application pins and verifies. Do not substitute an unversioned or unverified binary. The microphone usage description is already present so a future pinned implementation can request permission clearly.

## CI artifacts

The `build-macos` CI job runs on `macos-latest`, executes the test suite, packages `arm64` and `x64` in one invocation, validates both Mach-O architectures, checks updater metadata, and stores DMGs, ZIPs, blockmaps, the update manifest, and SHA-256 checksums as a CI artifact.

CI always invokes electron-builder with `--publish never`. This prevents an unsigned or partially notarized package from reaching a public release.

## Developer ID signing and notarization

Release signing uses a `Developer ID Application` identity and Apple's notarization service. Configure these encrypted repository secrets:

| Secret | Purpose |
|---|---|
| `MAC_CSC_LINK` | Base64 certificate archive or a private authenticated URL accepted by electron-builder |
| `MAC_CSC_KEY_PASSWORD` | Password for that certificate archive |
| `APPLE_API_KEY_BASE64` | Base64 contents of the App Store Connect `.p8` key |
| `APPLE_API_KEY_ID` | App Store Connect API key identifier |
| `APPLE_API_ISSUER` | App Store Connect API issuer UUID |

All five values are mandatory for macOS release publication. The workflow writes the API key to the ephemeral runner directory with mode `0600`; it does not print secret values. When any secret is missing, automatic identity discovery is disabled and macOS outputs remain CI-only.

For a version tag, the workflow attaches macOS assets to the GitHub release only after electron-builder completes signing/notarization and these validations pass:

```bash
codesign --verify --deep --strict --verbose=2 "Koinos AI.app"
spctl --assess --type execute --verbose=2 "Koinos AI.app"
xcrun stapler validate "Koinos AI.app"
```

electron-builder notarizes and staples the signed application bundle before it
creates the DMG and ZIP, so validation targets the application inside each
architecture output rather than assuming the disk image itself has a ticket.

Do not store certificates, passwords, private keys, or API keys in the repository. Local use of a real signing identity and any upload to Apple require explicit release-owner authorization.

## Release acceptance checklist

- All tests pass on a native macOS CI runner.
- Both application executables report the expected Mach-O architecture.
- DMG, ZIP, blockmap, `latest-mac.yml`, and checksum file exist.
- The update manifest contains both `arm64` and `x64` packages.
- `codesign`, Gatekeeper assessment, and stapler validation pass for both architecture-specific application bundles.
- Install, first launch, local chat, quit/relaunch, update, and uninstall are exercised on a clean Apple Silicon Mac.
- The same smoke sequence is exercised on a physical Intel Mac before Intel support is advertised.
- No voice support is claimed until a pinned, verified macOS whisper CLI is implemented and tested.

## Known limits

- Cross-packaging proves that the Intel Electron bundle is structurally correct; it does not replace physical Intel validation.
- An unsigned local DMG is suitable for developer testing only and will trigger Gatekeeper warnings.
- No public macOS release should be advertised until a real Developer ID build passes notarization and clean-machine smoke tests.
