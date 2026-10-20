"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), yaml = require("js-yaml");
const { publish, artifactTag } = require("../../scripts/publish-test-build");
const { PUBLISHER, hash, reportName, readVerifiedArtifacts } = require("../../scripts/windows-signing");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-publication-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const version = "0.54.12-test.197.1", tag = artifactTag(version), commit = "a".repeat(40);
  const env = { GITHUB_REPOSITORY: "therexdev/kaiapp", GITHUB_REF: "refs/heads/test", GITHUB_SHA: commit, GITHUB_RUN_ID: "999" };
  const setup = `Koinos-AI-Test-Setup-${version}-x64.exe`, portable = `Koinos-AI-Test-${version}-x64.exe`;
  const linux = `Koinos-AI-Test-${version}-x86_64.AppImage`, arm = `Koinos-AI-Test-${version}-arm64.AppImage`;
  for (const name of [setup, portable, setup + ".blockmap", linux, arm]) fs.writeFileSync(path.join(dir, name), "verified fixture bytes: " + name);
  const feed = (name, binary) => {
    const checksum = hash(path.join(dir, binary), "sha512", "base64");
    fs.writeFileSync(path.join(dir, name), yaml.dump({ version, path: binary, sha512: checksum, files: [{ url: binary, sha512: checksum, size: fs.statSync(path.join(dir, binary)).size }] }));
  };
  feed("test.yml", setup); feed("test-linux.yml", linux); feed("test-linux-arm64.yml", arm);
  const windows = [setup, portable, setup + ".blockmap", "test.yml"];
  const report = { schemaVersion: 1, version, publisher: PUBLISHER, commit, workflowRun: "999",
    signatures: [setup, portable].map(name => ({ path: name, status: "Valid", signatureType: "Authenticode", subject: PUBLISHER, timestampThumbprint: "timestamp", signToolExitCode: 0 })),
    artifacts: windows.map(name => ({ name, sha256: hash(path.join(dir, name)) })) };
  fs.writeFileSync(path.join(dir, reportName(version)), JSON.stringify(report));
  const feedNames = ["latest.yml", "latest-linux.yml", "latest-linux-arm64.yml", "test.yml", "test-linux.yml", "test-linux-arm64.yml"];
  let id = 10;
  const rolling = { id: 1, prerelease: true, draft: false, target_commitish: "historical", assets: new Map() };
  for (const name of [...feedNames, ...Array.from({ length: 994 }, (_, n) => `historical-${n}.exe`)]) rolling.assets.set(name, { id: id++, name, state: "uploaded", text: "previous:" + name });
  const releases = new Map([["test-build", rolling]]), refs = new Map(), writes = [];
  const unavailable = () => { throw Object.assign(Error("GitHub resource missing"), { status: 1, stderr: "HTTP 404" }); };
  const state = { failUpload: null };
  const gh = (...args) => {
    if (args[0] === "api" && args[1] === "--paginate") {
      const releaseId = Number(args[2].match(/releases\/(\d+)\/assets/)[1]);
      const release = [...releases.values()].find(r => r.id === releaseId);
      return [...release.assets.values()].map(({ id, name, state }) => JSON.stringify({ id, name, state })).join("\n");
    }
    if (args[0] === "api") {
      assert.notEqual(args[1], "-X", "successful historical assets must not be deleted");
      if (args[1].endsWith("/releases/latest")) return JSON.stringify({ tag_name: "v0.54.12", prerelease: false, draft: false, assets: feedNames.filter(n => n.startsWith("latest")).map(name => ({ name })) });
      if (args[1].includes("/releases/tags/")) {
        const value = releases.get(args[1].split("/releases/tags/")[1]); if (!value) return unavailable();
        const { assets, ...metadata } = value; return JSON.stringify(metadata);
      }
      if (args[1].includes("/git/ref/tags/")) {
        const sha = refs.get(args[1].split("/git/ref/tags/")[1]); return sha ? JSON.stringify({ type: "commit", sha }) : unavailable();
      }
    }
    if (args[0] === "release" && args[1] === "download") {
      const filename = args[args.indexOf("--pattern") + 1], destination = args[args.indexOf("--dir") + 1];
      fs.writeFileSync(path.join(destination, filename), yaml.dump({ version: "0.54.12", path: "Koinos-AI-Setup-0.54.12.exe", sha512: "live-hash", files: [{ url: "Koinos-AI-Setup-0.54.12.exe", sha512: "live-hash", size: 12 }] }));
      return "";
    }
    if (args[0] === "release" && args[1] === "create") {
      assert.ok(args.includes("--draft") && args.includes("--prerelease") && args.includes("--latest=false"));
      writes.push({ action: "create", tag: args[2] });
      releases.set(args[2], { id: 2, prerelease: true, draft: true, target_commitish: args[args.indexOf("--target") + 1], assets: new Map() }); return "";
    }
    if (args[0] === "release" && args[1] === "upload") {
      const release = releases.get(args[2]), file = args[5], name = path.basename(file);
      if (state.failUpload === name) throw Object.assign(Error("upload rejected"), { status: 1, stderr: "HTTP 422" });
      if (!release.assets.has(name) && release.assets.size >= 1000) throw Error("file_count limited to 1000 assets per release");
      if (args[2] === "test-build") {
        assert.equal(releases.get(tag).draft, false, "rolling feeds require public artifacts");
        assert.ok(feedNames.includes(name), "rolling release must not grow");
      }
      const text = fs.readFileSync(file, "utf8");
      writes.push({ action: "upload", tag: args[2], name });
      release.assets.set(name, { id: id++, name, state: "uploaded", text }); return "";
    }
    if (args[0] === "release" && args[1] === "edit") {
      assert.ok(args.includes("--draft=false") && args.includes("--prerelease") && args.includes("--latest=false"));
      const release = releases.get(args[2]);
      if (args[2] === tag) for (const name of feedNames.filter(n => n.startsWith("latest"))) assert.ok(release.assets.has(name), "legacy Live compatibility must exist before exposing a new prerelease");
      release.draft = false; refs.set(args[2], release.target_commitish);
      release.body = fs.readFileSync(args[args.indexOf("--notes-file") + 1], "utf8");
      writes.push({ action: "publish", tag: args[2] }); return "";
    }
    throw Error("Unexpected test GitHub call: " + args.join(" "));
  };
  return { dir, version, tag, commit, setup, portable, env, rolling, releases, refs, writes, state, gh };
}

test("publication at the 1000-asset limit keeps old downloads and publishes artifacts before bounded channel pointers", t => {
  const f = fixture(t); publish(f.dir, f);
  assert.equal(f.rolling.assets.size, 1000);
  assert.equal(f.rolling.assets.get("historical-0.exe").text, "previous:historical-0.exe");
  const artifacts = f.releases.get(f.tag);
  assert.equal(artifacts.draft, false); assert.equal(f.refs.get(f.tag), f.commit);
  const original = fs.readFileSync(path.join(f.dir, "test.yml"), "utf8");
  assert.equal(artifacts.assets.get("test.yml").text, original, "the verified Windows feed bytes remain with the report");
  const pointer = yaml.load(f.rolling.assets.get("test.yml").text);
  assert.equal(pointer.path, `../${f.tag}/${f.setup}`);
  assert.equal(pointer.sha512, yaml.load(original).sha512);
  assert.equal(yaml.load(f.rolling.assets.get("latest.yml").text).path, "../v0.54.12/Koinos-AI-Setup-0.54.12.exe");
  assert.ok(f.rolling.body.includes(`/download/${f.tag}/${f.setup}`));
  assert.ok(f.writes.findIndex(w => w.action === "publish" && w.tag === f.tag) < f.writes.findIndex(w => w.action === "upload" && w.tag === "test-build"));
  assert.equal(readVerifiedArtifacts(f.dir, { commit: f.commit, workflowRun: "999" }).report.version, f.version);
  // A publication retry reuses this source-pinned release without growing the
  // saturated rolling release or rewriting any historical payload.
  publish(f.dir, f); assert.equal(f.releases.size, 2); assert.equal(f.rolling.assets.size, 1000);
});

test("failed artifact upload leaves the new release private and the old update pointers intact", t => {
  const f = fixture(t); f.state.failUpload = f.portable;
  assert.throws(() => publish(f.dir, f), /upload rejected/);
  assert.equal(f.releases.get(f.tag).draft, true);
  assert.equal(f.rolling.assets.get("test.yml").text, "previous:test.yml");
  assert.equal(f.writes.some(w => w.tag === "test-build"), false);
});

test("source conflicts and changed verification bytes stop before any release writes", t => {
  const f = fixture(t); f.refs.set(f.tag, "b".repeat(40));
  assert.throws(() => publish(f.dir, f), /does not match the verified source/);
  assert.equal(f.writes.length, 0);
  f.refs.clear(); fs.appendFileSync(path.join(f.dir, f.setup), "changed");
  assert.throws(() => publish(f.dir, f), /changed after verification/);
  assert.equal(f.writes.length, 0);
});
