"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const yaml = require("js-yaml");
const semver = require("semver");
const { readVerifiedArtifacts, hash } = require("./windows-signing");
const { stableCompatibility } = require("./publish-test-build");
const REPO = "therexdev/kaiapp";
const TAG = "master-build"; // Non-semver, isolated from Test and Alpha updates.

function releaseFiles(dir, env) {
  if (env.GITHUB_REPOSITORY !== REPO || env.GITHUB_REF !== "refs/heads/master-kaiapp") {
    throw new Error("Master publication must run from therexdev/kaiapp:master-kaiapp");
  }
  const pkg = require("../package.json");
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+-master\.\d+$/.test(version) || pkg.kaiChannel !== "master" ||
      pkg.build.publish[0].repo !== "kaiapp") throw new Error("Invalid Master release identity");
  const windows = readVerifiedArtifacts(dir, { commit: env.GITHUB_SHA, workflowRun: env.GITHUB_RUN_ID });
  if (windows.report.version !== version || !windows.names.includes("master.yml")) throw new Error("Windows version/channel mismatch");
  const names = fs.readdirSync(dir);
  if (names.some(name => /^(latest|test).*\.yml$/.test(name))) throw new Error("Foreign update feed in Master release");
  const images = names.filter(name => /^Master-Koinos-AI-Node-.*-linux-x64\.AppImage$/.test(name));
  if (images.length !== 1) throw new Error("Expected one Linux x64 AppImage");
  const feed = yaml.load(fs.readFileSync(path.join(dir, "master-linux.yml"), "utf8"));
  if (feed.version !== version || feed.path !== images[0] || !Array.isArray(feed.files) || feed.files.length !== 1) {
    throw new Error("Linux update feed/version mismatch");
  }
  const file = feed.files[0], image = path.join(dir, images[0]);
  if (file.url !== images[0] || file.size !== fs.statSync(image).size ||
      file.sha512 !== hash(image, "sha512", "base64") || feed.sha512 !== file.sha512) {
    throw new Error("Linux update feed does not match the installer");
  }
  return { version, tag: TAG, names: [...windows.names, windows.reportFile, ...images, "master-linux.yml"] };
}

function publish(dir, { env = process.env, gh = (...args) => execFileSync("gh", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}) } = {}) {
  // All signatures, workflow identity and feed hashes are verified before the
  // first GitHub write. Only exact artifacts from this run can be released.
  const { version, tag, names } = releaseFiles(dir, env);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "master-release-"));
  try {
    const checksums = path.join(temp, `SHA256SUMS-${version}`);
    fs.writeFileSync(checksums, names.map(name => `${hash(path.join(dir, name))}  ${name}`).join("\n") + "\n");
    const provenance = path.join(temp, `build-${version}.json`);
    fs.writeFileSync(provenance, JSON.stringify({ version, commit: env.GITHUB_SHA, workflowRun: env.GITHUB_RUN_ID }, null, 2) + "\n");
    const notes = path.join(temp, "notes.md");
    const setup = names.find(name => /^Master-Koinos-AI-Node-Setup-.*\.exe$/.test(name));
    if (!setup) throw new Error("Master Windows Setup installer missing");
    let existing;
    try {
      existing = JSON.parse(gh("api", `repos/${REPO}/releases/tags/${tag}`));
    } catch (error) {
      if (error.status !== 1 || !/HTTP 404/.test(String(error.stderr))) throw error;
    }
    if (existing) {
      if (!existing.prerelease) throw new Error("master-build must remain a prerelease");
      const publishedVersions = (existing.assets || []).map(a => /^build-(.+)\.json$/.exec(a.name)?.[1]).filter(v => semver.valid(v));
      if (!existing.draft && (publishedVersions.some(v => semver.gte(v, version)) || existing.assets?.some(a => a.name === setup))) {
        throw new Error("Master version already exists; use a new version instead of replacing published files");
      }
    }
    // Older Alpha updaters may inspect the newest prerelease. Give them only
    // compatibility pointers to the original stable installers, never Master.
    const stable = JSON.parse(gh("api", `repos/${REPO}/releases/latest`));
    if (stable.draft || stable.prerelease || !/^v\d+\.\d+\.\d+$/.test(stable.tag_name)) throw new Error("No stable Alpha release available");
    const compatibility = [];
    for (const asset of stable.assets.filter(a => /^latest(?:-[\w-]+)?\.yml$/.test(a.name))) {
      gh("release", "download", stable.tag_name, "--repo", REPO, "--pattern", asset.name, "--dir", temp);
      const file = path.join(temp, asset.name);
      fs.writeFileSync(file, stableCompatibility(fs.readFileSync(file, "utf8"), stable.tag_name));
      compatibility.push(file);
    }
    if (!compatibility.some(file => path.basename(file) === "latest.yml")) throw new Error("Missing stable Windows compatibility feed");
    fs.writeFileSync(notes, `Master Koinos AI Node ${version}\n\n[Download the Windows Setup installer](https://github.com/${REPO}/releases/download/${tag}/${setup})\n\nIncludes the full Distribution tab, the local producer-data API, and Koinos Blocks as primary RPC with api.koinos.io as backup.\n\nMaster uses a separate app profile and update channel. Before replacing Free Koinos Node, follow the [migration instructions](https://github.com/${REPO}/blob/${env.GITHUB_SHA}/docs/MASTER_NODE.md#migration-from-free-koinos-node).\n\nThe other Windows EXE is the portable app. The AppImage is for Linux x64. Windows executables are signed and timestamped with the existing Michael Milas publisher identity.\n\nSource: ${env.GITHUB_SHA}\nBuild: https://github.com/${REPO}/actions/runs/${env.GITHUB_RUN_ID}\n\nThe master*.yml files update Master only. The latest*.yml files are compatibility pointers to Alpha ${stable.tag_name}; Test remains on test-build. Versioned binaries and build manifests identify the exact source for each Master build.\n`);
    if (!existing) {
      gh("release", "create", tag, "--repo", REPO, "--target", env.GITHUB_SHA,
        "--draft", "--prerelease", "--latest=false", "--title", `Master Koinos AI Node ${version}`, "--notes-file", notes);
    }
    // Keep older versioned files for in-flight downloads. Advance Master feeds
    // only after binaries/evidence upload; first publication stays a draft.
    const feeds = names.filter(name => /^master.*\.yml$/.test(name));
    const binaries = names.filter(name => !feeds.includes(name));
    for (const file of [...binaries.map(name => path.join(dir, name)), checksums, provenance, ...compatibility, ...feeds.map(name => path.join(dir, name))]) {
      gh("release", "upload", tag, "--repo", REPO, file, "--clobber");
    }
    gh("release", "edit", tag, "--repo", REPO, "--draft=false", "--prerelease", "--latest=false",
      "--title", `Master Koinos AI Node ${version}`, "--notes-file", notes);
    console.log(`Published https://github.com/${REPO}/releases/tag/${tag}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

if (require.main === module) publish(path.resolve(process.argv[2] || "artifacts"));
module.exports = { publish, releaseFiles };
