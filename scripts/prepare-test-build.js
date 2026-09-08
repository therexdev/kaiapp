"use strict";

const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");

function prepare(rootDir, buildNumber, attempt = "1") {
  for (const n of [buildNumber, attempt]) {
    if (!/^[1-9]\d*$/.test(String(n))) throw new Error("Build and attempt must be positive integers");
  }
  const file = path.join(rootDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (pkg.kaiChannel === "test") throw new Error("Already prepared; use a fresh checkout");
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  const version = `${major}.${minor}.${patch + 1}-test.${buildNumber}.${attempt}`;
  pkg.version = version;
  pkg.name = "koinos-ai-test";
  pkg.productName = "Koinos AI Test";
  pkg.kaiChannel = "test";
  pkg.build.appId = "io.koinosai.desktop.test";
  pkg.build.productName = pkg.productName;
  pkg.build.generateUpdatesFilesForAllChannels = false;
  pkg.build.publish = [{
    provider: "generic",
    url: "https://github.com/therexdev/kaiapp/releases/download/test-build/",
    channel: "test",
  }];
  pkg.build.artifactName = "Koinos-AI-Test-${version}-${arch}.${ext}";
  pkg.build.nsis.artifactName = "Koinos-AI-Test-Setup-${version}-${arch}.${ext}";
  pkg.build.nsis.shortcutName = pkg.productName;
  // Installing Test must not claim the live app's koinos-code command.
  delete pkg.build.nsis.include;
  // Keep the companion's runtime helper without shipping the live CLI launchers.
  pkg.build.win.extraResources = [{
    from: "build/bin/kai-windows-voice.exe",
    to: "bin/kai-windows-voice.exe",
  }];
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  const coreFile = path.join(rootDir, "core/package.json");
  const core = JSON.parse(fs.readFileSync(coreFile, "utf8"));
  core.version = version;
  fs.writeFileSync(coreFile, JSON.stringify(core, null, 2) + "\n");
  return version;
}

if (require.main === module) console.log(prepare(root, process.argv[2], process.argv[3] || "1"));
module.exports = { prepare };
