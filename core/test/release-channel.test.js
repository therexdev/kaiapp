"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const semver = require("semver");
const yaml = require("js-yaml");
const { channelConfig, configureDesktop, configureUpdater, TEST_FEED } = require("../lib/release-channel");
const { prepare } = require("../../scripts/prepare-test-build");
const { stableCompatibility, findTestRelease, purgeIncompleteAssets, uploadReleaseAssets, artifactTag, relocatedTestFeed } = require("../../scripts/publish-test-build");
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider");
const { GenericProvider } = require("electron-updater/out/providers/GenericProvider");

test("Test keeps its installer identity but opens the live profile and services", () => {
  const stable = channelConfig("stable");
  const test = channelConfig("test");
  for (const key of ["appId", "productName"]) assert.notEqual(test[key], stable[key]);
  for (const key of ["port", "ollamaPort", "homeDirName"]) assert.equal(test[key], stable[key]);
  const paths = { appData: path.join(os.tmpdir(), "app-data"), userData: "existing-live-profile" };
  let credentialName;
  const app = { getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; }, setName(name) { credentialName = name; }, setAppUserModelId() {} };
  configureDesktop(app, stable);
  assert.equal(paths.userData, "existing-live-profile");
  configureDesktop(app, test);
  assert.equal(paths.userData, path.join(paths.appData, "Koinos AI"));
  assert.equal(paths.sessionData, paths.userData);
  assert.equal(credentialName, "Koinos AI");
  assert.throws(() => channelConfig("beta"), /Unknown/);
});

test("Only the Test updater receives the Test feed, with downgrades disabled", () => {
  const calls = [];
  const updater = { setFeedURL(value) { calls.push(value); }, set channel(value) { this._channel = value; this.allowDowngrade = true; } };
  configureUpdater(updater, channelConfig("stable"));
  assert.equal(updater.allowPrerelease, false);
  assert.equal(calls.length, 0);
  configureUpdater(updater, channelConfig("test"));
  assert.deepEqual(calls, [{ provider: "generic", url: TEST_FEED, channel: "test" }]);
  assert.equal(updater._channel, "test");
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, false);
});

test("Packaging Test separates installer identity and does not claim the live CLI", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-channel-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "core"));
  const source = require("../../package.json");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(source));
  fs.writeFileSync(path.join(root, "core/package.json"), JSON.stringify(require("../package.json")));
  const version = prepare(root, "12", "2");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json")));
  assert.equal(pkg.version, `${semver.inc(source.version, "patch")}-test.12.2`);
  assert.equal(pkg.version, version);
  assert.equal(pkg.name, "koinos-ai-test");
  assert.equal(pkg.build.appId, "io.koinosai.desktop.test");
  assert.equal(pkg.build.publish[0].channel, "test");
  assert.equal(pkg.build.generateUpdatesFilesForAllChannels, false);
  assert.equal(pkg.build.nsis.include, undefined);
  assert.deepEqual(pkg.build.win.extraResources, [{
    from: "build/bin", to: "bin", filter: ["kai-windows-voice.exe", "kai-computer.exe"],
  }], "Test needs private helpers but must not copy the live CLI launchers");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "core/package.json"))).version, version);
  assert.throws(() => prepare(root, "13"), /Already prepared/);
});

const stableFeed = yaml.dump({ version: "0.54.1", files: [{ url: "Koinos-AI-Setup-0.54.1.exe", sha512: "stable-hash", size: 123 }], path: "Koinos-AI-Setup-0.54.1.exe", sha512: "stable-hash" });

for (const tag of ["test-build", "test-build-0.54.2-test.12.2"]) test(`A legacy live GitHub updater seeing ${tag} resolves only the original stable installer`, async () => {
  const compatibility = stableCompatibility(stableFeed, "v0.54.1");
  const requested = [];
  const updater = { allowPrerelease: true, currentVersion: new semver.SemVer("0.54.0"), fullChangelog: false };
  const executor = { request: async (options) => { requested.push(options.path); return compatibility; } };
  const provider = new GitHubProvider({ provider: "github", owner: "therexdev", repo: "kaiapp" }, updater, { executor, platform: "win32", isUseMultipleRangeRequest: false });
  provider.httpRequest = async () => `<feed><entry><title>Test</title><link href="https://github.com/therexdev/kaiapp/releases/tag/${tag}"/><content>Test channel</content></entry></feed>`;
  const latest = await provider.getLatestVersion();
  assert.equal(latest.version, "0.54.1");
  assert.ok(requested.every(p => p.endsWith(`/${tag}/latest.yml`)));
  const [file] = provider.resolveFiles(latest);
  assert.equal(file.url.href, "https://github.com/therexdev/kaiapp/releases/download/v0.54.1/Koinos-AI-Setup-0.54.1.exe");
  assert.equal(file.info.sha512, "stable-hash");
});

test("Test's generic provider reads test.yml and resolves only Test binaries", async () => {
  const updater = { channel: "test", isAddNoCacheQuery: false };
  const provider = new GenericProvider({ provider: "generic", url: TEST_FEED, channel: "test" }, updater, { executor: {}, platform: "win32", isUseMultipleRangeRequest: false });
  provider.httpRequest = async url => {
    assert.equal(url.href, `${TEST_FEED}test.yml`);
    return yaml.dump({ version: "0.54.2-test.12.2", files: [{ url: "Koinos-AI-Test-Setup-0.54.2-test.12.2-x64.exe", sha512: "test-hash" }] });
  };
  const latest = await provider.getLatestVersion();
  assert.equal(latest.version, "0.54.2-test.12.2");
  assert.equal(provider.resolveFiles(latest)[0].url.href, `${TEST_FEED}Koinos-AI-Test-Setup-0.54.2-test.12.2-x64.exe`);
});

test("Test's unchanged generic feed resolves new per-build artifacts with their original hashes", async () => {
  const version = "0.54.2-test.12.2", name = `Koinos-AI-Test-Setup-${version}-x64.exe`;
  const original = yaml.dump({ version, path: name, sha512: "test-hash", files: [{ url: name, sha512: "test-hash", size: 123 }] });
  const redirected = relocatedTestFeed(original, version, [name]);
  const provider = new GenericProvider({ provider: "generic", url: TEST_FEED, channel: "test" }, { channel: "test", isAddNoCacheQuery: false }, { executor: {}, platform: "win32", isUseMultipleRangeRequest: false });
  provider.httpRequest = async url => { assert.equal(url.href, `${TEST_FEED}test.yml`); return redirected; };
  const update = await provider.getLatestVersion(), [file] = provider.resolveFiles(update);
  assert.equal(file.url.href, `https://github.com/therexdev/kaiapp/releases/download/${artifactTag(version)}/${name}`);
  assert.equal(file.info.sha512, "test-hash"); assert.equal(file.info.size, 123);
  assert.equal(semver.valid(artifactTag(version)), null);
  assert.throws(() => relocatedTestFeed(original, "0.54.2-test.13.1", [name]), /Invalid Test/);
  assert.throws(() => relocatedTestFeed(original, version, []), /Unsafe/);
  assert.throws(() => relocatedTestFeed(original.replaceAll(name, "https://example.com/app.exe"), version, ["https://example.com/app.exe"]), /Unsafe/);
});

test("Compatibility feeds reject a prerelease version or untrusted asset path", () => {
  assert.throws(() => stableCompatibility(stableFeed, "v0.55.0-test.1"));
  assert.throws(() => stableCompatibility(stableFeed, "v0.55.0"), /mismatch/);
  assert.throws(() => stableCompatibility(stableFeed.replaceAll("Koinos-AI-Setup-0.54.1.exe", "https://example.com/installer.exe"), "v0.54.1"), /Unsafe/);
});

test("Release lookup requests only the rolling release and bounds its response", () => {
  const result = findTestRelease((...args) => {
    assert.deepEqual(args, ["api", "repos/therexdev/kaiapp/releases/tags/test-build", "--jq", "{id,prerelease,draft,target_commitish}"]);
    return '{"id":42,"prerelease":true,"draft":false}';
  });
  assert.deepEqual(result, { id: 42, prerelease: true, draft: false });
});

test("Only a confirmed missing release permits creation; authentication errors propagate", () => {
  const failure = (status) => () => { throw Object.assign(new Error("GitHub failed"), { status: 1, stderr: `gh: HTTP ${status}` }); };
  assert.equal(findTestRelease((...args) => args[1] === "--paginate" ? "" : failure(404)()), null);
  assert.throws(() => findTestRelease(failure(403)), /GitHub failed/);
  assert.throws(() => findTestRelease(() => { throw new Error("network unavailable"); }), /network unavailable/);
  assert.throws(() => findTestRelease((...args) => failure(args[1] === "--paginate" ? 403 : 404)()), /GitHub failed/);
  assert.throws(() => findTestRelease(failure(404)), /GitHub failed/, "a failed listing does not confirm absence");
});

test("Draft lookup paginates exact-tag matches and reads the selected release by ID", () => {
  const tag = "test-build-0.54.12-test.199.1", calls = [];
  const result = findTestRelease((...args) => {
    calls.push(args);
    if (calls.length === 1) throw Object.assign(Error("published release missing"), { status: 1, stderr: "HTTP 404" });
    if (calls.length === 2) {
      assert.deepEqual(args, ["api", "--paginate", "repos/therexdev/kaiapp/releases?per_page=100", "--jq", `.[] | select(.tag_name == "${tag}") | {id}`]);
      return '{"id":419009039}\n';
    }
    assert.deepEqual(args, ["api", "repos/therexdev/kaiapp/releases/419009039", "--jq", "{id,tag_name,prerelease,draft,target_commitish}"]);
    return JSON.stringify({ id: 419009039, tag_name: tag, prerelease: true, draft: true, target_commitish: "a".repeat(40) });
  }, tag);
  assert.deepEqual(result, { id: 419009039, prerelease: true, draft: true, target_commitish: "a".repeat(40) });
  assert.equal(calls.length, 3);
});

test("Draft lookup rejects ambiguous tags, changed identity, and disappearing releases", () => {
  const gh = (listing, release) => (...args) => {
    if (args[1].includes("/releases/tags/")) throw Object.assign(Error("not published"), { status: 1, stderr: "HTTP 404" });
    if (args[1] === "--paginate") return listing;
    if (release instanceof Error) throw release;
    return JSON.stringify(release);
  };
  assert.throws(() => findTestRelease(gh('{"id":1}\n{"id":2}')), /Ambiguous/);
  assert.throws(() => findTestRelease(gh('{"id":1}', { id: 1, tag_name: "another-tag" })), /tag mismatch/);
  assert.throws(() => findTestRelease(gh('{"id":1}', Object.assign(Error("draft disappeared"), { status: 1, stderr: "HTTP 404" }))), /draft disappeared/);
});

test("Test publication removes only incomplete assets and retries one transient upload at a time", () => {
  const calls = []; let listings = 0, uploads = 0;
  const gh = (...args) => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "--paginate") {
      listings++;
      return listings === 1 ? [
        '{"id":1,"name":"old-good.exe","state":"uploaded"}',
        '{"id":2,"name":"broken.AppImage","state":"starter"}',
      ].join("\n") : listings === 2 ? '{"id":3,"name":"new.AppImage","state":"starter"}' : "";
    }
    if (args[0] === "release") {
      uploads++;
      if (uploads === 1) throw Object.assign(new Error("upload failed"), { stderr: "HTTP 500: Error saving asset" });
    }
    return "";
  };
  assert.deepEqual(purgeIncompleteAssets(gh, 42), ["broken.AppImage"]);
  const waits = [];
  uploadReleaseAssets(gh, 42, ["/tmp/new.AppImage", "/tmp/feed.yml"], { wait: ms => waits.push(ms) });
  assert.deepEqual(waits, [5000]);
  assert.equal(uploads, 3, "the failed file is retried, then the next file uploads once");
  assert.ok(calls.some(args => args.join(" ").includes("releases/assets/2")));
  assert.ok(calls.some(args => args.join(" ").includes("releases/assets/3")));
  assert.ok(calls.filter(args => args[0] === "release").every(args => args.filter(value => /\.(?:AppImage|yml)$/.test(value)).length === 1));
});
