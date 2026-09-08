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
const { stableCompatibility, findTestRelease } = require("../../scripts/publish-test-build");
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
    from: "build/bin/kai-windows-voice.exe", to: "bin/kai-windows-voice.exe",
  }, { from: "build/bin/kai-computer.exe", to: "bin/kai-computer.exe" }], "Test needs private helpers but must not copy the live CLI launchers");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "core/package.json"))).version, version);
  assert.throws(() => prepare(root, "13"), /Already prepared/);
});

const stableFeed = yaml.dump({ version: "0.54.1", files: [{ url: "Koinos-AI-Setup-0.54.1.exe", sha512: "stable-hash", size: 123 }], path: "Koinos-AI-Setup-0.54.1.exe", sha512: "stable-hash" });

test("A legacy live GitHub updater seeing test-build resolves only the original stable installer", async () => {
  const compatibility = stableCompatibility(stableFeed, "v0.54.1");
  const requested = [];
  const updater = { allowPrerelease: true, currentVersion: new semver.SemVer("0.54.0"), fullChangelog: false };
  const executor = { request: async (options) => { requested.push(options.path); return compatibility; } };
  const provider = new GitHubProvider({ provider: "github", owner: "therexdev", repo: "kaiapp" }, updater, { executor, platform: "win32", isUseMultipleRangeRequest: false });
  provider.httpRequest = async () => '<feed><entry><title>Test</title><link href="https://github.com/therexdev/kaiapp/releases/tag/test-build"/><content>Test channel</content></entry></feed>';
  const latest = await provider.getLatestVersion();
  assert.equal(latest.version, "0.54.1");
  assert.ok(requested.every(p => p.endsWith("/test-build/latest.yml")));
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

test("Compatibility feeds reject a prerelease version or untrusted asset path", () => {
  assert.throws(() => stableCompatibility(stableFeed, "v0.55.0-test.1"));
  assert.throws(() => stableCompatibility(stableFeed, "v0.55.0"), /mismatch/);
  assert.throws(() => stableCompatibility(stableFeed.replaceAll("Koinos-AI-Setup-0.54.1.exe", "https://example.com/installer.exe"), "v0.54.1"), /Unsafe/);
});

test("Release lookup requests only the rolling release and bounds its response", () => {
  const result = findTestRelease((...args) => {
    assert.deepEqual(args, ["api", "repos/therexdev/kaiapp/releases/tags/test-build", "--jq", "{prerelease,draft}"]);
    return '{"prerelease":true,"draft":false}';
  });
  assert.deepEqual(result, { prerelease: true, draft: false });
});

test("Only a confirmed missing release permits creation; authentication errors propagate", () => {
  const failure = (status) => () => { throw Object.assign(new Error("GitHub failed"), { status: 1, stderr: `gh: HTTP ${status}` }); };
  assert.equal(findTestRelease(failure(404)), null);
  assert.throws(() => findTestRelease(failure(403)), /GitHub failed/);
  assert.throws(() => findTestRelease(() => { throw new Error("network unavailable"); }), /network unavailable/);
});
