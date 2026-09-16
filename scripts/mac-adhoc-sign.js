"use strict";

// electron-builder `afterPack` hook.
//
// The prebuilt Electron.app that ships in the npm package is already ad-hoc
// signed, with Identifier=Electron. electron-builder then injects app.asar,
// our resources, and a rewritten Info.plist into that bundle. When a real
// Developer ID is configured electron-builder re-signs afterwards and the seal
// is rebuilt correctly. But when signing is disabled (the Alpha default:
// CSC_IDENTITY_AUTO_DISCOVERY=false, or simply no certificate) electron-builder
// leaves the bundle exactly as it mutated it — carrying the original Electron
// ad-hoc seal, which no longer describes the contents. `codesign --verify`
// then reports "code has no resources but signature indicates they must be
// present" and the bundle is internally invalid, which is what shipped in
// v0.54.8 (Identifier=Electron, Sealed Resources=none, Info.plist=not bound).
//
// The fix is to ad-hoc re-sign the whole bundle ourselves so the signature is
// internally consistent (correct identifier, sealed resources, bound
// Info.plist). This is NOT Developer ID and NOT notarized: Signature stays
// adhoc and TeamIdentifier stays unset. Gatekeeper still requires the one-time
// right-click -> Open on first launch, and in-place auto-update is still
// unavailable — but `codesign --verify --deep --strict` passes.
//
// afterPack runs BEFORE electron-builder's own code-signing step, so when a
// real Developer ID IS configured our ad-hoc signature is simply overwritten
// by the notarized one. Existing signed-build behavior is preserved untouched.

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

// Decide whether this build should be ad-hoc signed. Returns false only when a
// real signing identity is being supplied to electron-builder, in which case we
// let it sign (and let auto-discovery find a keychain identity if enabled).
//
// The explicit-certificate check comes first on purpose: if CSC_LINK/CSC_IDENTITY
// is set, electron-builder will sign with it even when auto-discovery is disabled,
// so we must defer regardless of CSC_IDENTITY_AUTO_DISCOVERY. (Our own ad-hoc seal
// would be harmlessly overwritten by the --force Developer ID sign, but deferring
// is clearer and avoids wasted work.)
function shouldAdhocSign(env = process.env) {
  if (env.CSC_LINK || env.CSC_IDENTITY) return false; // real identity provided -> electron-builder signs
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return true; // explicitly unsigned, no certificate
  return true; // nothing configured -> default to an internally-valid ad-hoc seal
}

function adhocSign(appPath) {
  // --deep re-seals every nested helper, framework and the outer bundle.
  // --sign - is the ad-hoc identity: no certificate, no team.
  //
  // Deliberately NO `--options runtime` and NO --entitlements here, even though
  // package.json sets hardenedRuntime + entitlements for signed builds. Hardened
  // runtime is enforced independently, but without notarization it adds no
  // Gatekeeper trust to an ad-hoc bundle. It would also
  // enable library validation, which requires nested code to share the signer's
  // Team ID — an ad-hoc bundle has none, so `--options runtime` risks the Electron
  // framework and helper processes failing to load. Plain ad-hoc keeps JIT working
  // and the bundle loadable. The signed path applies hardened runtime + the
  // entitlements via electron-builder; this hook does not run for it.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
}

function verifySignature(appPath) {
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "inherit" });
}

async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.platform !== "darwin") {
    // codesign is macOS-only; a macOS bundle cannot be validly produced off a
    // Mac anyway. Say so rather than sign nothing silently.
    console.warn("mac-adhoc-sign: not on macOS, cannot ad-hoc sign the bundle");
    return;
  }
  if (!shouldAdhocSign(process.env)) {
    console.log("mac-adhoc-sign: Developer ID configured, leaving signing to electron-builder");
    return;
  }

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) throw new Error(`mac-adhoc-sign: app bundle not found at ${appPath}`);

  console.log(`mac-adhoc-sign: ad-hoc signing ${appPath}`);
  adhocSign(appPath);
  // Fail the build here if the seal is still broken, so an internally invalid
  // bundle can never reach the DMG/ZIP targets or a release.
  verifySignature(appPath);
  console.log("mac-adhoc-sign: bundle is internally valid (ad-hoc, unsigned)");
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.shouldAdhocSign = shouldAdhocSign;
module.exports.adhocSign = adhocSign;
module.exports.verifySignature = verifySignature;
