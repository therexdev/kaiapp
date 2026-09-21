"use strict";
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), assert = require("assert/strict");
const zlib = require("zlib");
const { execFileSync } = require("child_process");
const { UPSTREAM, GO_VERSION } = require("./build-block-store");
const ROOT = path.resolve(__dirname, "..");
const source = path.join(ROOT, "patches/history-repair");
const hash = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function build(out = path.join(ROOT, "build/history-repair")) {
  const go = process.env.KAI_GO || "go";
  if (!execFileSync(go, ["version"], { encoding: "utf8" }).includes(` ${GO_VERSION} `)) throw new Error(`Require ${GO_VERSION}`);
  const provenance = JSON.parse(fs.readFileSync(path.join(source, "batch-provenance.json")));
  const candidate = zlib.gunzipSync(Buffer.from(fs.readFileSync(path.join(source, "batch.json.gz.base64"), "utf8").trim(), "base64")).toString("utf8");
  const digest = data => crypto.createHash("sha256").update(data).digest("hex");
  assert.equal(digest(candidate), provenance.payloadSha256);
  const values = JSON.parse(candidate);
  assert.equal(values.length, 502);
  // Snapshots differed ONLY in the optional state-root field; every available
  // root is checked against its successor header by the compiled helper.
  for (const value of values) delete value.receipt.state_merkle_root;
  const canonical = x => x && typeof x === "object" ? (Array.isArray(x) ? x.map(canonical) : Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]))) : x;
  const normalized = digest(JSON.stringify(canonical(values)));
  assert.equal(normalized, provenance.normalizedSha256);
  assert.equal(provenance.sources.length, 2);
  for (const provider of provenance.sources) assert.equal(provider.normalizedSha256, normalized);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-history-repair-build-"));
  const run = (bin, args, opts = {}) => execFileSync(bin, args, { stdio: "inherit", ...opts });
  try {
    run("git", ["clone", "--quiet", "--depth", "1", "--branch", "v1.1.0", "https://github.com/koinos/koinos-block-store.git", dir]);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), UPSTREAM);
    run("git", ["apply", path.join(ROOT, "patches/koinos-block-store/missing-record.patch")], { cwd: dir });
    const cmd = path.join(dir, "cmd/kai-history-repair");
    fs.mkdirSync(cmd, { recursive: true });
    for (const name of ["main.go", "main_test.go"]) fs.copyFileSync(path.join(source, name), path.join(cmd, name));
    fs.cpSync(path.join(source, "testdata"), path.join(cmd, "testdata"), { recursive: true });
    if (candidate.includes("`")) throw new Error("Unexpected payload encoding");
    fs.writeFileSync(path.join(cmd, "candidate_data.go"), "package main\nvar batchJSON = []byte(`" + candidate + "`)\nconst batchPayloadSHA256 = " + JSON.stringify(provenance.payloadSha256) + "\n");
    const env = { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "-mod=readonly" };
    delete env.KAI_REPAIR_SMOKE_FIXTURE;
    run(go, ["test", "./...", "-count=1"], { cwd: dir, env });
    run(go, ["test", "-race", "./cmd/kai-history-repair", "-count=1"], { cwd: dir, env });
    fs.mkdirSync(out, { recursive: true });
    run(go, ["build", "-trimpath", "-buildvcs=false", "-ldflags", "-s -w", "-o", path.join(out, "kai_history_repair"), "./cmd/kai-history-repair"], { cwd: dir, env: { ...env, GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" } });
    for (const name of ["Repair-History.ps1", "Start-Repair.cmd", "README.txt"]) fs.copyFileSync(path.join(source, name), path.join(out, name));
    fs.copyFileSync(path.join(source, "batch-provenance.json"), path.join(out, "provenance.json"));
    fs.copyFileSync(path.join(dir, "LICENSE.md"), path.join(out, "LICENSE.md"));
    const names = ["kai_history_repair", "Repair-History.ps1", "Start-Repair.cmd", "README.txt", "LICENSE.md", "provenance.json"];
    fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ schemaVersion: 1, repair: "mainnet-6033501-6034000-v2", platform: "linux/amd64", upstreamCommit: UPSTREAM, goVersion: GO_VERSION, payloadSha256: provenance.payloadSha256, files: names.map(name => ({ name, sha256: hash(path.join(out, name)) })) }, null, 2) + "\n");
    // A disposable real Badger fixture lets CI exercise the built ELF in the
    // original Docker image with exactly the offline flags used on Windows.
    if (process.env.KAI_REPAIR_SMOKE_FIXTURE) {
      run(go, ["test", "./cmd/kai-history-repair", "-run", "^TestExportSmokeFixture$", "-count=1"], { cwd: dir, env: { ...env, KAI_REPAIR_SMOKE_FIXTURE: process.env.KAI_REPAIR_SMOKE_FIXTURE } });
    }
    console.log(`Verified repair package: ${out}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
if (require.main === module) build(path.resolve(process.argv[2] || path.join(ROOT, "build/history-repair")));
module.exports = { build };
