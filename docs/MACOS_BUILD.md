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

Setting `CSC_IDENTITY_AUTO_DISCOVERY=false` is important for reproducible developer builds: it prevents electron-builder from silently selecting a certificate from the local keychain. The `afterPack` hook (`scripts/mac-adhoc-sign.js`) then **ad-hoc signs** the bundle so it is internally valid, and fails the build if it is not — see [Ad-hoc signing for unsigned builds](#ad-hoc-signing-for-unsigned-builds) below. Outputs are written to `dist/` and include:

- `koinos-ai-<version>-arm64.dmg` and `.zip`;
- `koinos-ai-<version>-x64.dmg` and `.zip`;
- blockmaps and `latest-mac.yml` for update delivery.

Inspect the application executables after packaging:

```bash
file "dist/mac-arm64/Koinos AI.app/Contents/MacOS/Koinos AI"
file "dist/mac/Koinos AI.app/Contents/MacOS/Koinos AI"
```

The first must report `arm64`; the second must report `x86_64`.

## Ad-hoc signing for unsigned builds

electron-builder starts from the prebuilt `Electron.app` that npm ships, which is
already ad-hoc signed with `Identifier=Electron`. It then injects `app.asar`, our
resources, and a rewritten `Info.plist` into that bundle. When a Developer ID is
configured, electron-builder re-signs afterwards and the seal is rebuilt. When
signing is disabled — the Alpha default (`CSC_IDENTITY_AUTO_DISCOVERY=false`) or
simply no certificate — electron-builder leaves the bundle carrying the original
Electron seal, which no longer matches the mutated contents. That is what shipped
in **v0.54.8**: `codesign --verify --deep --strict` failed with *"code has no
resources but signature indicates they must be present"*, and `codesign -dvv`
reported `Identifier=Electron`, `Signature=adhoc`, `Sealed Resources=none`,
`Info.plist=not bound`.

The `afterPack` hook `scripts/mac-adhoc-sign.js` fixes this by ad-hoc re-signing
the whole bundle (`codesign --force --deep --sign -`) whenever a real identity is
not supplied, then verifying the result and failing the build if the seal is
still broken. The hook runs **before** electron-builder's own signing step, so a
configured Developer ID simply overwrites the ad-hoc signature — signed-build
behavior is unchanged.

An ad-hoc signature is **not** Developer ID and **not** notarized: `Signature`
stays `adhoc` and `TeamIdentifier` stays unset. What changes is only internal
validity — the bundle now has the correct identifier (`io.koinosai.desktop`),
sealed resources, and a bound `Info.plist`, so `codesign --verify --deep
--strict` passes. Gatekeeper still requires the one-time right-click → **Open**
on first launch, and in-place auto-update is still unavailable. This is not a
substitute for signing/notarization; it makes the unsigned artifact honest and
internally consistent rather than corrupt.

The ad-hoc re-sign deliberately does **not** apply hardened runtime
(`--options runtime`) or the `entitlements` from `package.json`, even though
signed builds do. Hardened runtime is enforced independently, but without
notarization — which an ad-hoc bundle can never have — it adds no Gatekeeper
trust. It would also switch on library validation, which requires
nested code to share the signer's Team ID; an ad-hoc bundle has no team, so the
runtime flag risks the Electron framework and helper processes failing to load.
The ad-hoc `CodeDirectory` therefore shows `flags=0x2(adhoc)` with no runtime bit
and no entitlements, and JIT keeps working. The `allow-jit` /
`allow-unsigned-executable-memory` entitlements only take effect under hardened
runtime, so they belong to the signed path (where electron-builder applies them),
not here.

`scripts/verify-mac-signature.js` re-checks every packaged `.app` after the build
(in CI and locally) and rejects any bundle whose signature is invalid or still
carries the prebuilt `Electron` identity. It runs for both signed and unsigned
builds, so the v0.54.8 artifact can never be published again.

## Runtime behavior

The runtime catalog pins the official llama.cpp `b10423` macOS archives by URL, byte size, and SHA-256 for both architectures. Apple Silicon tries the Metal-capable runtime first and falls back to CPU execution with GPU layers disabled if startup fails. The official Intel archive is CPU-only, so Intel Macs do not enter a misleading Metal rung. Adjacent `.dylib` files resolve through `DYLD_LIBRARY_PATH` scoped only to the child process.

Managed Node.js packages are also pinned for both Darwin architectures, so MCP tools do not require a separate system Node installation.

The managed Koinos node uses the same official Compose template and image tags as the other platforms, with one macOS-specific materialization step. Docker Desktop rejects file-backed Compose `configs` whose targets sit inside the separately bind-mounted `/koinos` tree. On macOS, Core therefore copies `config.yml`, `genesis_data.json`, and `koinos_descriptors.pb` into their normal paths under `BASEDIR` and removes only those nested config mounts from the generated Compose file. Linux and Windows keep the upstream-shaped Compose configuration unchanged.

Mainnet JSON-RPC is exposed on `127.0.0.1:8085`, matching the current `koinos/koinos` example and avoiding the commonly occupied development port `8080`. The service still listens on port `8080` inside its container. Node startup requires Docker Desktop and sufficient disk for chain data; the application does not enable block production or register a signing key unless the user separately opts in.

Voice transcription remains gracefully unavailable on macOS because upstream whisper.cpp `v1.9.2` does not publish the CLI archive that this application pins and verifies. Do not substitute an unversioned or unverified binary. The microphone usage description is already present so a future pinned implementation can request permission clearly.

## CI artifacts

The `build-macos` CI job runs on `macos-latest`, executes the test suite, packages `arm64` and `x64` in one invocation, validates both Mach-O architectures, checks updater metadata, runs `scripts/verify-mac-signature.js` to confirm every bundle carries a valid (ad-hoc or Developer ID) signature, and stores DMGs, ZIPs, blockmaps, the update manifest, and SHA-256 checksums as a CI artifact. The signature check runs for signed and unsigned builds alike, so a bundle with a broken seal fails the job before anything is published.

CI always invokes electron-builder with `--publish never`, so electron-builder never uploads anything itself. Publication is a separate, explicit step.

### What gets published while we are in Alpha

The contributed workflow withheld the macOS build entirely unless Developer ID
signing was configured. That is the right rule for a stable release and the
wrong one here: this repository has no Apple certificate yet, so it would mean
Mac testers get nothing at all while Windows and Linux testers get every build.

So a tagged release always attaches the macOS DMG and ZIP, and what changes is
what we say about them:

| | Signed + notarized | Unsigned (today) |
|---|---|---|
| First launch | Opens normally | Gatekeeper blocks it; the tester must right-click the app and choose **Open**, once |
| In-place update | Works | **Not possible** — macOS refuses to swap an unsigned bundle, so each version is a fresh download |
| `latest-mac.yml` | Published | Withheld, deliberately: it is what tells an installed app an update is waiting, and offering an update that cannot install is worse than not offering one |

Both of those facts belong in the release notes rather than in a silent
difference between platforms. Revisit this section once the repository has a
Developer ID — see below for what that takes.

## Developer ID signing and notarization

Release signing uses a `Developer ID Application` identity and Apple's notarization service. Configure these encrypted repository secrets:

| Secret | Purpose |
|---|---|
| `MAC_CSC_LINK` | Base64 certificate archive or a private authenticated URL accepted by electron-builder |
| `MAC_CSC_KEY_PASSWORD` | Password for that certificate archive |
| `APPLE_API_KEY_BASE64` | Base64 contents of the App Store Connect `.p8` key |
| `APPLE_API_KEY_ID` | App Store Connect API key identifier |
| `APPLE_API_ISSUER` | App Store Connect API issuer UUID |

All five values are mandatory for SIGNED macOS release publication; the build
still ships unsigned without them, as described above. Getting them requires an
Apple Developer Program membership (currently 99 USD/year) in the name that
should appear on the certificate — that membership, not the workflow, is the
actual blocker for signed Mac builds.

The workflow writes the API key to the ephemeral runner directory with mode
`0600`; it does not print secret values. When any secret is missing, automatic
identity discovery is disabled and the assets are published unsigned.

When the secrets ARE present, a version tag attaches the assets only after electron-builder completes signing/notarization and these validations pass:

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
- `codesign --verify --deep --strict` passes for both architecture-specific application bundles on every build (ad-hoc or Developer ID), enforced by `scripts/verify-mac-signature.js`.
- Gatekeeper assessment (`spctl`) and stapler validation pass for both bundles (signed builds only — these steps are skipped, not failed, when there is no Developer ID).
- Install, first launch, local chat, quit/relaunch, update, and uninstall are exercised on a clean Apple Silicon Mac.
- The same smoke sequence is exercised on a physical Intel Mac before Intel support is advertised.
- No voice support is claimed until a pinned, verified macOS whisper CLI is implemented and tested.

## Known limits

- Cross-packaging proves that the Intel Electron bundle is structurally correct; it does not replace physical Intel validation.
- An unsigned DMG triggers Gatekeeper warnings and cannot auto-update. It is
  what Alpha testers get today, on purpose, and the release notes say so. The
  bundle is ad-hoc signed so it is internally valid (`codesign --verify` passes),
  but ad-hoc signing is not notarization — it does not remove the Gatekeeper
  prompt or enable in-place updates.
- Checksums for every platform live in the single `SHA256SUMS` file the
  `provenance` job publishes, alongside the SBOM and the build attestation;
  the macOS job does not write a competing checksum file of its own.
- macOS should not be advertised as generally available — as opposed to
  offered to Alpha testers — until a real Developer ID build passes
  notarization and clean-machine smoke tests.
