"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const yaml = require("js-yaml");
const { PUBLISHER, configureSigning, assertSignature, hash, reportName, readVerifiedArtifacts } = require("../../scripts/windows-signing");

const credentials = { AZ_ACCOUNT: "account", AZ_PROFILE: "profile", AZURE_TENANT_ID: "tenant", AZURE_CLIENT_ID: "client", AZURE_CLIENT_SECRET: "never-print-this" };
const signature = name => ({ path: name, status: "Valid", signatureType: "Authenticode", subject: PUBLISHER,
  timestampThumbprint: "timestamp", signerThumbprint: "rotating-leaf", signToolExitCode: 0 });
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-sign-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Windows release signing fails closed for each missing credential without exposing values", () => {
  const pkg = require("../../package.json");
  for (const key of Object.keys(credentials)) {
    const env = { ...credentials, [key]: " " };
    assert.throws(() => configureSigning(pkg, env), error => error.message.includes(key) && !error.message.includes(credentials.AZURE_CLIENT_SECRET));
  }
  const configured = configureSigning(pkg, credentials);
  assert.equal(configured.build.win.forceCodeSigning, true);
  assert.equal(configured.build.win.verifyUpdateCodeSignature, true);
  assert.equal(configured.build.win.azureSignOptions.publisherName, PUBLISHER);
  assert.equal(configured.build.win.azureSignOptions.fileDigest, "SHA256");
  assert.equal(configured.build.win.azureSignOptions.timestampDigest, "SHA256");
  assert.equal(JSON.stringify(configured).includes(credentials.AZURE_CLIENT_SECRET), false);
  assert.equal(pkg.build.win.azureSignOptions, undefined, "Source configuration must not be mutated");
});

test("Signature gate rejects unsigned, untrusted, untimestamped, wrong-publisher and SignTool-warning results", () => {
  for (const change of [{ status: "NotSigned" }, { status: "HashMismatch" }, { status: "NotTrusted" },
    { signatureType: "Catalog" }, { subject: "CN=Another publisher" }, { subject: "CN=Michael Milas, O=Other organization" },
    { timestampThumbprint: null }, { signToolExitCode: 1 }, { signToolExitCode: 2 }]) {
    assert.throws(() => assertSignature({ ...signature("app.exe"), ...change }));
  }
  assert.doesNotThrow(() => assertSignature({ ...signature("app.exe"), signerThumbprint: "new-Azure-leaf" }));
  assert.doesNotThrow(() => assertSignature({ ...signature("app.exe"), subject: PUBLISHER.replace("S=", "ST=") }));
});

function releaseFixture(t) {
  const dir = tempDir(t), version = "0.54.9";
  const names = ["Koinos AI Setup 0.54.9.exe", "Koinos AI 0.54.9.exe", "Koinos AI Setup 0.54.9.exe.blockmap", "latest.yml"].sort();
  for (const name of names) fs.writeFileSync(path.join(dir, name), `fixture:${name}`);
  const setup = names.find(n => n.includes(" Setup ") && n.endsWith(".exe"));
  const checksum = hash(path.join(dir, setup), "sha512", "base64");
  fs.writeFileSync(path.join(dir, "latest.yml"), yaml.dump({ version, path: setup.replace(/ /g, "-"), sha512: checksum,
    files: [{ url: setup.replace(/ /g, "-"), sha512: checksum, size: fs.statSync(path.join(dir, setup)).size }] }));
  const report = { schemaVersion: 1, version, publisher: PUBLISHER, commit: "source", workflowRun: "123",
    signatures: names.filter(n => n.endsWith(".exe")).map(signature), artifacts: names.map(name => ({ name, sha256: hash(path.join(dir, name)) })) };
  const write = () => fs.writeFileSync(path.join(dir, reportName(version)), JSON.stringify(report));
  write();
  return { dir, report, write, identity: { commit: "source", workflowRun: "123" }, setup };
}

test("Publication accepts only matching Windows evidence and an updater feed with the verified bytes", t => {
  const f = releaseFixture(t);
  assert.equal(readVerifiedArtifacts(f.dir, f.identity).report.version, "0.54.9");
  assert.throws(() => readVerifiedArtifacts(f.dir, { ...f.identity, commit: "other" }), /does not match/);
  assert.throws(() => readVerifiedArtifacts(f.dir, { ...f.identity, workflowRun: "124" }), /does not match/);
  fs.appendFileSync(path.join(f.dir, f.setup), "modified");
  assert.throws(() => readVerifiedArtifacts(f.dir, f.identity), /changed after verification/);
  // Even rehashing a changed binary in the report must not accept a stale feed.
  f.report.artifacts.find(a => a.name === f.setup).sha256 = hash(path.join(f.dir, f.setup)); f.write();
  assert.throws(() => readVerifiedArtifacts(f.dir, f.identity), /feed does not match/);
});

test("Publication rejects missing evidence, missing artifacts, extra executables and missing signature results", t => {
  const f = releaseFixture(t);
  fs.writeFileSync(path.join(f.dir, "extra.exe"), "unexpected");
  assert.throws(() => readVerifiedArtifacts(f.dir, f.identity), /exactly one/);
  fs.unlinkSync(path.join(f.dir, "extra.exe"));
  f.report.signatures = []; f.write();
  assert.throws(() => readVerifiedArtifacts(f.dir, f.identity), /Missing signature evidence/);
  fs.unlinkSync(path.join(f.dir, reportName(f.report.version)));
  assert.throws(() => readVerifiedArtifacts(f.dir, f.identity), /ENOENT/);
  fs.unlinkSync(path.join(f.dir, f.setup));
  assert.throws(() => readVerifiedArtifacts(f.dir, f.identity), /exactly one/);
});

test("Test helper resource copies invoke the builder signing transformer and exclude live CLI launchers", async t => {
  const { prepare } = require("../../scripts/prepare-test-build");
  const { FileMatcher, copyFiles } = require("app-builder-lib/out/fileMatcher");
  const { CopyFileTransformer } = require("builder-util");
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "core")); fs.mkdirSync(path.join(dir, "build/bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(require("../../package.json")));
  fs.writeFileSync(path.join(dir, "core/package.json"), JSON.stringify(require("../package.json")));
  for (const file of ["kai-windows-voice.exe", "kai-computer.exe", "koinos-code.cmd"]) fs.writeFileSync(path.join(dir, "build/bin", file), file);
  prepare(dir, "1");
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json")));
  const signed = [];
  const matchers = pkg.build.win.extraResources.map(m => new FileMatcher(path.join(dir, m.from), path.join(dir, "output", m.to), x => x, m.filter));
  await copyFiles(matchers, () => new CopyFileTransformer(async file => { signed.push(path.basename(file)); return true; }));
  assert.deepEqual(signed.sort(), ["kai-computer.exe", "kai-windows-voice.exe"]);
  assert.equal(fs.existsSync(path.join(dir, "output/bin/koinos-code.cmd")), false);
});

test("Both release workflows verify before any Windows artifact upload", () => {
  for (const [file, job] of [["ci.yml", "build-windows"], ["test-release.yml", "windows"]]) {
    const workflow = yaml.load(fs.readFileSync(path.join(__dirname, "../../.github/workflows", file), "utf8"));
    const steps = workflow.jobs[job].steps;
    const build = steps.findIndex(s => s.run?.includes("npm run dist -- --win --publish never"));
    const gate = steps.findIndex(s => s.run?.includes("node scripts/verify-windows-signatures.js"));
    const upload = steps.findIndex(s => s.uses?.startsWith("actions/upload-artifact") && /^(kai-test-windows|koinos-ai-windows)$/.test(s.with?.name));
    assert.ok(build >= 0 && gate > build && upload > gate);
    const publish = steps.findIndex(s => s.run?.includes("node scripts/publish-windows-release.js"));
    if (job === "build-windows") assert.ok(publish > gate);
  }
});

test("Native Windows inspection rejects an unsigned executable and a different publisher", { skip: process.platform !== "win32" }, t => {
  const { inspectFiles } = require("../../scripts/verify-windows-signatures");
  const dir = tempDir(t), source = path.join(dir, "unsigned.cs"), exe = path.join(dir, "unsigned [test] 'app.exe");
  fs.writeFileSync(source, "class Unsigned { static void Main() {} }");
  execFileSync(path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"), ["/nologo", `/out:${exe}`, source]);
  const microsoft = path.join(process.env.WINDIR, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const records = inspectFiles([exe, microsoft]);
  assert.equal(records.length, 2);
  assert.equal(records[0].status, "NotSigned");
  assert.equal(records[1].status, "Valid", "Windows must trust its own PowerShell binary for this integration check");
  for (const record of records) assert.throws(() => assertSignature(record));
});
