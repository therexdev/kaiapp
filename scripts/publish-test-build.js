"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const yaml = require("js-yaml");
const { readVerifiedArtifacts } = require("./windows-signing");
const TAG = "test-build"; // Deliberately NOT semver: legacy updaters use latest*.yml.
const REPO = "therexdev/kaiapp";

function findTestRelease(gh, tag = TAG) {
  try {
    return JSON.parse(gh("api", `repos/${REPO}/releases/tags/${tag}`, "--jq", "{id,prerelease,draft,target_commitish}"));
  } catch (error) {
    // GitHub's by-tag endpoint only returns published releases. A draft can
    // already exist, so a 404 alone is not permission to create another one.
    if (error.status !== 1 || !/HTTP 404/.test(String(error.stderr))) throw error;
  }
  const output = gh("api", "--paginate", `repos/${REPO}/releases?per_page=100`,
    "--jq", `.[] | select(.tag_name == ${JSON.stringify(tag)}) | {id}`).trim();
  const matches = output ? output.split(/\r?\n/).map(line => JSON.parse(line)) : [];
  if (!matches.length) return null;
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) throw new Error("Ambiguous Test release lookup");
  // Read the exact release again, rather than trusting a possibly stale list.
  // Permission/network errors (including a disappearing draft) stop publication.
  const release = JSON.parse(gh("api", `repos/${REPO}/releases/${matches[0].id}`,
    "--jq", "{id,tag_name,prerelease,draft,target_commitish}"));
  if (release.id !== matches[0].id || release.tag_name !== tag) throw new Error("Test release lookup tag mismatch");
  const { tag_name, ...metadata } = release;
  return metadata;
}

function createTestRelease(gh, { tag, commit, title, body, requestFile }) {
  fs.writeFileSync(requestFile, JSON.stringify({ tag_name: tag, target_commitish: commit,
    name: title, body, draft: true, prerelease: true, make_latest: "false" }));
  // Newly created drafts can be absent from GitHub's release listing briefly.
  // Use the creation response's identity instead of rediscovering it by tag.
  const release = JSON.parse(gh("api", "--method", "POST", `repos/${REPO}/releases`,
    "--input", requestFile, "--jq", "{id,tag_name,prerelease,draft,target_commitish}"));
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.tag_name !== tag ||
      release.prerelease !== true || release.draft !== true || release.target_commitish !== commit) {
    throw new Error("Created Test release does not match its requested identity and verified source");
  }
  const { tag_name, ...metadata } = release;
  return metadata;
}

function releaseAssets(gh, releaseId) {
  const output = gh("api", "--paginate", `repos/${REPO}/releases/${releaseId}/assets?per_page=100`,
    "--jq", ".[] | {id,name,state}").trim();
  return output ? output.split(/\r?\n/).map(line => JSON.parse(line)) : [];
}

function purgeIncompleteAssets(gh, releaseId, name = null) {
  const removed = [];
  for (const asset of releaseAssets(gh, releaseId)) {
    if (asset.state === "uploaded" || (name && asset.name !== name)) continue;
    gh("api", "-X", "DELETE", `repos/${REPO}/releases/assets/${asset.id}`);
    removed.push(asset.name);
  }
  return removed;
}

function retryableUpload(error) {
  const detail = String(error?.stderr || error?.message || error);
  return /HTTP (?:429|5\d\d)|ECONNRESET|ETIMEDOUT|timeout|connection reset|remote end closed/i.test(detail);
}

function uploadReleaseAssets(gh, releaseId, files, { tag = TAG, attempts = 3, wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  // An interrupted GitHub upload leaves a non-downloadable `starter` record.
  // Remove only incomplete records; versioned, successfully uploaded binaries
  // remain available for clients already downloading an older Test build.
  purgeIncompleteAssets(gh, releaseId);
  for (const file of files) {
    const name = path.basename(file);
    for (let attempt = 1; ; attempt++) {
      try {
        // One file per request prevents a single large Linux image failure
        // from replaying every Windows/Linux artifact in the release.
        gh("release", "upload", tag, "--repo", REPO, file, "--clobber");
        break;
      } catch (error) {
        if (attempt >= attempts || !retryableUpload(error)) throw error;
        purgeIncompleteAssets(gh, releaseId, name);
        wait(attempt * 5000);
      }
    }
  }
}

function stableCompatibility(text, tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error("Expected a stable release tag");
  const data = yaml.load(text);
  if (data.version !== tag.slice(1)) throw new Error("Stable feed/version mismatch");
  const stablePath = (name) => {
    if (typeof name !== "string" || !/^[\w .-]+$/.test(name)) throw new Error("Unsafe release filename");
    // GitHubProvider always prepends /download/<tag>/, even for absolute URLs.
    // A sibling path resolves to the ORIGINAL stable asset with its original hash.
    return `../${tag}/${name.replace(/ /g, "-")}`;
  };
  for (const file of data.files || []) file.url = stablePath(file.url);
  if (data.path) data.path = stablePath(data.path);
  return yaml.dump(data);
}

function artifactTag(version) {
  if (!/^\d+\.\d+\.\d+-test\.\d+\.\d+$/.test(version)) throw new Error("Invalid test version");
  // Do not use a semver tag: older Live updaters derive a Test channel from it.
  return `test-build-${version}`;
}

function relocatedTestFeed(text, version, binaries) {
  const data = yaml.load(text), tag = artifactTag(version);
  if (data.version !== version || !Array.isArray(data.files) || !data.files.length) throw new Error("Invalid Test update feed");
  const relocate = name => {
    if (typeof name !== "string" || !binaries.includes(name) || !name.includes(version) || !/^Koinos-AI-Test-[\w.-]+\.(?:exe|AppImage)$/.test(name)) throw new Error("Unsafe Test release filename");
    return `../${tag}/${name}`;
  };
  for (const file of data.files) file.url = relocate(file.url);
  if (data.path) data.path = relocate(data.path);
  return yaml.dump(data);
}

function assertArtifactTarget(gh, tag, commit, { draft = false } = {}) {
  let ref;
  try { ref = JSON.parse(gh("api", `repos/${REPO}/git/ref/tags/${tag}`, "--jq", "{type:.object.type,sha:.object.sha}")); }
  catch (error) { if (draft && error.status === 1 && /HTTP 404/.test(String(error.stderr))) return; throw error; }
  if (ref.type !== "commit" || ref.sha !== commit) throw new Error("Test artifact tag does not match the verified source");
}

function publish(dir, { env = process.env, gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) } = {}) {
  if (env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/test") {
    throw new Error("Test publication must run from therexdev/kaiapp:test");
  }
  // Fail before any GitHub write if Windows verification is absent or stale.
  const windows = readVerifiedArtifacts(dir, { commit: env.GITHUB_SHA, workflowRun: env.GITHUB_RUN_ID });
  const latest = JSON.parse(gh("api", `repos/${REPO}/releases/latest`, "--jq", "{tag_name,prerelease,draft,assets:[.assets[]|{name}]}"));
  if (latest.prerelease || latest.draft) throw new Error("No published live release available");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-test-release-"));
  try {
    // Build compatibility files BEFORE publishing anything. Older live copies
    // have allowPrerelease=true; they must keep receiving only stable installers.
    const compatibility = [];
    for (const asset of latest.assets.filter(a => /^latest.*\.yml$/.test(a.name))) {
      gh("release", "download", latest.tag_name, "--repo", REPO, "--pattern", asset.name, "--dir", temp);
      const file = path.join(temp, asset.name);
      fs.writeFileSync(file, stableCompatibility(fs.readFileSync(file, "utf8"), latest.tag_name));
      compatibility.push(file);
    }
    if (!compatibility.some(f => path.basename(f) === "latest.yml")) throw new Error("Missing live Windows feed");
    const names = fs.readdirSync(dir);
    if (names.some(n => /^latest.*\.yml$/.test(n))) throw new Error("Test build emitted live update metadata");
    const feeds = names.filter(n => /^test(?:-linux(?:-arm64)?)?\.yml$/.test(n));
    for (const expected of ["test.yml", "test-linux.yml", "test-linux-arm64.yml"]) {
      if (!feeds.includes(expected)) throw new Error(`Missing ${expected}`);
    }
    const versions = new Set(feeds.map(n => yaml.load(fs.readFileSync(path.join(dir, n), "utf8")).version));
    if (versions.size !== 1) throw new Error("Platform versions disagree");
    const [version] = versions;
    const buildTag = artifactTag(version);
    const binaries = names.filter(n => /^Koinos-AI-Test-.*\.(exe|AppImage|blockmap)$/.test(n));
    if (!binaries.some(n => /^Koinos-AI-Test-Setup-.*\.exe$/.test(n))) throw new Error("Windows installer missing");
    const sums = binaries.map(n => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, n))).digest("hex")}  ${n}`).join("\n") + "\n";
    const checksum = path.join(temp, `SHA256SUMS-${version}`);
    fs.writeFileSync(checksum, sums);
    const provenance = path.join(temp, `build-${version}.json`);
    fs.writeFileSync(provenance, JSON.stringify({ version, commit: env.GITHUB_SHA, workflowRun: env.GITHUB_RUN_ID, stableCompatibility: latest.tag_name, artifactTag: buildTag }, null, 2) + "\n");
    // Keep the original feeds beside their Windows verification report. Only
    // rolling channel pointers change location; installer hashes stay intact.
    const feedDir = path.join(temp, "feeds"); fs.mkdirSync(feedDir);
    const channelFeeds = feeds.map(name => {
      const file = path.join(feedDir, name);
      fs.writeFileSync(file, relocatedTestFeed(fs.readFileSync(path.join(dir, name), "utf8"), version, binaries));
      return file;
    });
    const body = path.join(temp, "notes.md");
    const whatsNew = fs.readFileSync(path.join(__dirname, "../docs/TEST_WHATS_NEW.md"), "utf8").trim();
    const setup = binaries.find(n => /^Koinos-AI-Test-Setup-.*\.exe$/.test(n));
    fs.writeFileSync(body, `## Koinos AI Test ${version}\n\n[Download the Windows test installer](https://github.com/${REPO}/releases/download/${buildTag}/${setup})\n\n${whatsNew}\n\nUses your existing live Koinos AI chats, settings, wallet, models and node-data location. Test updates stay on this channel; other users stay on Live. Local API: port 41100.\n\nBefore switching, choose **Quit Koinos AI** from the running app’s tray menu (closing the window may only hide it), then install and open Test. Only one version can open the shared profile at a time. The saved wallet session and earning preference are reused; unlock your existing wallet if prompted and check node/earning status after the restart. Test backs up configuration and encrypted wallet/session files before first opening the profile for each version. Your existing live network and node database remain in use. Older isolated Test profiles are left untouched.\n\nSource commit: ${env.GITHUB_SHA}\nBuild: https://github.com/${REPO}/actions/runs/${env.GITHUB_RUN_ID}\n\nThe rolling tag identifies this download channel. [This build’s artifacts and verification reports](https://github.com/${REPO}/releases/tag/${buildTag}) identify its exact source and files. Earlier download URLs remain available; each new build has its own artifact release. The latest*.yml files are compatibility pointers to live ${latest.tag_name}, never test installers.\n`);
    let existing = findTestRelease(gh);
    if (!existing) {
      existing = createTestRelease(gh, { tag: TAG, commit: env.GITHUB_SHA, title: "Koinos AI Test",
        body: fs.readFileSync(body, "utf8"), requestFile: path.join(temp, "create-rolling.json") });
    } else if (!existing.prerelease) {
      throw new Error("test-build must remain a prerelease");
    }
    // GitHub limits each release to 1,000 assets. Keep all historical URLs
    // intact and put each new build in a separate, source-pinned release.
    let artifacts = findTestRelease(gh, buildTag);
    if (!artifacts) {
      assertArtifactTarget(gh, buildTag, env.GITHUB_SHA, { draft: true });
      artifacts = createTestRelease(gh, { tag: buildTag, commit: env.GITHUB_SHA, title: `Koinos AI Test ${version} artifacts`,
        body: fs.readFileSync(body, "utf8"), requestFile: path.join(temp, "create-artifacts.json") });
    }
    if (!artifacts || !artifacts.prerelease || artifacts.target_commitish !== env.GITHUB_SHA) throw new Error("Test artifact release does not match the verified source");
    assertArtifactTarget(gh, buildTag, env.GITHUB_SHA, { draft: artifacts.draft });
    const payloads = [...binaries.map(n => path.join(dir, n)), checksum, provenance, path.join(dir, windows.reportFile), ...feeds.map(n => path.join(dir, n)), ...compatibility];
    uploadReleaseAssets(gh, artifacts.id, payloads, { tag: buildTag });
    const uploaded = releaseAssets(gh, artifacts.id);
    if (payloads.some(file => !uploaded.some(asset => asset.name === path.basename(file) && asset.state === "uploaded"))) throw new Error("Test artifact release is incomplete");
    // Even legacy Live clients may see this prerelease first in GitHub's Atom
    // feed. Publish only after stable latest*.yml compatibility files exist.
    gh("release", "edit", buildTag, "--repo", REPO, "--draft=false", "--prerelease", "--latest=false",
      "--title", `Koinos AI Test ${version} artifacts`, "--notes-file", body);
    assertArtifactTarget(gh, buildTag, env.GITHUB_SHA);
    // The rolling release grows no further: replace its existing bounded feed
    // names only, after the complete artifact release is publicly available.
    uploadReleaseAssets(gh, existing.id, compatibility);
    uploadReleaseAssets(gh, existing.id, channelFeeds);
    gh("release", "edit", TAG, "--repo", REPO, "--draft=false", "--prerelease", "--latest=false",
      "--title", `Koinos AI Test ${version}`, "--notes-file", body);
    console.log(`Published Test ${version}; live remains ${latest.tag_name}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

if (require.main === module) publish(path.resolve(process.argv[2] || "artifacts"));
module.exports = { stableCompatibility, findTestRelease, releaseAssets, purgeIncompleteAssets, retryableUpload, uploadReleaseAssets, artifactTag, relocatedTestFeed, assertArtifactTarget, publish };
