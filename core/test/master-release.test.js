"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const yaml = require("js-yaml");
const { publish, releaseFiles } = require("../../scripts/publish-master-build");
const { PUBLISHER, hash, reportName } = require("../../scripts/windows-signing");
const version = require("../../package.json").version;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "master-publish-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { GITHUB_REPOSITORY: "therexdev/kaiapp", GITHUB_REF: "refs/heads/master-kaiapp", GITHUB_SHA: "fixture-source", GITHUB_RUN_ID: "123" };
  const setup = `Master-Koinos-AI-Node-Setup-${version}-x64.exe`;
  const portable = `Master-Koinos-AI-Node-${version}-win-x64.exe`;
  const image = `Master-Koinos-AI-Node-${version}-linux-x64.AppImage`;
  for (const name of [setup, portable, setup + ".blockmap", image]) fs.writeFileSync(path.join(dir, name), `fixture ${name}`);
  const feed = (name, artifact) => {
    const file = path.join(dir, artifact), sha512 = hash(file, "sha512", "base64");
    fs.writeFileSync(path.join(dir, name), yaml.dump({ version, path: artifact, sha512,
      files: [{ url: artifact, sha512, size: fs.statSync(file).size }] }));
  };
  feed("master.yml", setup); feed("master-linux.yml", image);
  const names = [setup, portable, setup + ".blockmap", "master.yml"];
  const report = { schemaVersion: 1, version, publisher: PUBLISHER, commit: env.GITHUB_SHA, workflowRun: env.GITHUB_RUN_ID,
    signatures: [setup, portable].map(name => ({ path: name, status: "Valid", signatureType: "Authenticode", subject: PUBLISHER, timestampThumbprint: "fixture", signToolExitCode: 0 })),
    artifacts: names.map(name => ({ name, sha256: hash(path.join(dir, name)) })) };
  fs.writeFileSync(path.join(dir, reportName(version)), JSON.stringify(report));
  const calls = [];
  const gh = (...args) => {
    calls.push(args);
    if (args[0] === "api" && args[1].endsWith("/releases/latest")) return JSON.stringify({ tag_name: "v0.54.9", draft: false, prerelease: false, assets: [{ name: "latest.yml" }] });
    if (args[0] === "api") throw Object.assign(new Error("missing"), { status: 1, stderr: "HTTP 404" });
    if (args[1] === "download") {
      fs.writeFileSync(path.join(args.at(-1), "latest.yml"), yaml.dump({ version: "0.54.9", path: "Alpha-Setup.exe", sha512: "alpha-hash", files: [{ url: "Alpha-Setup.exe", sha512: "alpha-hash", size: 123 }] }));
    }
    return "";
  };
  return { dir, env, gh, calls, setup, image };
}

test("Master publication requires the right repository, commit and signed bytes before any GitHub call", t => {
  const f = fixture(t);
  assert.ok(releaseFiles(f.dir, f.env).names.includes(f.setup));
  for (const patch of [{ GITHUB_REPOSITORY: "therexdev/master-kaiapp" }, { GITHUB_REF: "refs/heads/test" }, { GITHUB_SHA: "other" }, { GITHUB_RUN_ID: "other" }]) {
    assert.throws(() => publish(f.dir, { env: { ...f.env, ...patch }, gh: f.gh }));
  }
  fs.appendFileSync(path.join(f.dir, f.setup), "changed");
  assert.throws(() => publish(f.dir, { env: f.env, gh: f.gh }), /changed after verification/);
  assert.deepEqual(f.calls, []);
});

test("Master publication refuses changed Linux bytes before creating a draft", t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.dir, f.image), "changed");
  assert.throws(() => publish(f.dir, { env: f.env, gh: f.gh }), /Linux update feed/);
  assert.deepEqual(f.calls, []);
});

test("Master release stays a draft until installers, feeds, checksums and provenance upload", t => {
  const f = fixture(t);
  publish(f.dir, { env: f.env, gh: f.gh });
  assert.ok(f.calls.find(args => args[1] === "create").includes("--draft"));
  const uploads = f.calls.filter(args => args[1] === "upload").map(args => path.basename(args[5]));
  for (const name of [f.setup, f.image, "master.yml", "master-linux.yml", reportName(version), `SHA256SUMS-${version}`, `build-${version}.json`]) assert.ok(uploads.includes(name));
  assert.equal(f.calls.at(-1)[1], "edit");
  assert.ok(f.calls.at(-1).includes("--draft=false"));
});

test("an interrupted Master upload cannot publish a partial release", t => {
  const f = fixture(t);
  const gh = (...args) => {
    if (args[1] === "upload") { f.calls.push(args); throw new Error("upload interrupted"); }
    return f.gh(...args);
  };
  assert.throws(() => publish(f.dir, { env: f.env, gh }), /interrupted/);
  assert.equal(f.calls.some(args => args[1] === "edit"), false);
});

test("Master publisher never overwrites an already published version", t => {
  const f = fixture(t);
  const gh = (...args) => {
    f.calls.push(args);
    return JSON.stringify({ draft: false, prerelease: true, assets: [{ name: `build-${version}.json` }] });
  };
  assert.throws(() => publish(f.dir, { env: f.env, gh }), /use a new version/);
  assert.equal(f.calls.length, 1);
});
