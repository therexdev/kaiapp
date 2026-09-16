"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const yaml = require("js-yaml");
const { PUBLISHER, assertSignature, hash, artifactFiles, reportName, readVerifiedArtifacts } = require("./windows-signing");

function inspectFiles(files) {
  if (process.platform !== "win32") throw new Error("Authenticode release verification must run on Windows");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-signatures-"));
  try {
    const manifest = path.join(temp, "files.json"), output = path.join(temp, "signatures.json");
    fs.writeFileSync(manifest, JSON.stringify(files));
    // Use the same PowerShell edition as the GitHub runner. Windows PowerShell
    // 5 inherits PS7's module path and can fail to load its Security module.
    execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(__dirname, "inspect-windows-signatures.ps1"), "-ManifestPath", manifest, "-OutputPath", output],
    { stdio: "inherit", windowsHide: true, timeout: 300000 });
    return JSON.parse(fs.readFileSync(output, "utf8").replace(/^\uFEFF/, ""));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function verify(dir) {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  if (!pkg.build.win.forceCodeSigning || pkg.build.win.verifyUpdateCodeSignature !== true ||
      pkg.build.win.azureSignOptions?.publisherName !== PUBLISHER) throw new Error("Mandatory Windows signing was not configured");
  const names = artifactFiles(dir);
  const appDir = path.join(dir, "win-unpacked");
  for (const name of [`${pkg.build.productName}.exe`, "resources/elevate.exe", "resources/bin/kai-windows-voice.exe", "resources/bin/kai-computer.exe"]) {
    if (!fs.statSync(path.join(appDir, name)).isFile()) throw new Error(`Missing packaged executable: ${name}`);
  }
  const updater = yaml.load(fs.readFileSync(path.join(appDir, "resources/app-update.yml"), "utf8"));
  if (JSON.stringify(updater.publisherName) !== JSON.stringify([PUBLISHER])) throw new Error("Packaged updater has no pinned publisher identity");
  const walk = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(root, e.name)) :
    e.isFile() && e.name.endsWith(".exe") ? [path.join(root, e.name)] : []);
  const files = [...names.filter(n => n.endsWith(".exe")).map(n => path.join(dir, n)), ...walk(appDir)];
  const signatures = inspectFiles(files);
  if (signatures.length !== files.length) throw new Error("Windows signature verification returned incomplete results");
  signatures.forEach((record, i) => {
    if (record.path !== files[i]) throw new Error("Signature result path mismatch");
    assertSignature(record);
    record.path = path.relative(dir, record.path).split(path.sep).join("/");
  });
  const report = {
    schemaVersion: 1, version: pkg.version, publisher: PUBLISHER,
    commit: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID,
    verifiedAt: new Date().toISOString(), signatures,
    artifacts: names.map(name => ({ name, releaseName: name.replace(/ /g, "-"), sha256: hash(path.join(dir, name)) })),
  };
  fs.writeFileSync(path.join(dir, reportName(pkg.version)), JSON.stringify(report, null, 2) + "\n");
  readVerifiedArtifacts(dir, report);
  console.log(`Verified ${signatures.length} signed Windows executables, timestamps, publisher and updater hashes.`);
}

if (require.main === module) verify(path.resolve(process.argv[2] || "dist"));
module.exports = { inspectFiles, verify };
