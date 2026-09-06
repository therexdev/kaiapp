"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const yaml = require("js-yaml");
const TAG = "test-build"; // Deliberately NOT semver: legacy updaters use latest*.yml.
const REPO = "therexdev/kaiapp";

function findTestRelease(gh) {
  try {
    return JSON.parse(gh("api", `repos/${REPO}/releases/tags/${TAG}`, "--jq", "{prerelease,draft}"));
  } catch (error) {
    // A missing first release is expected. Auth/network failures must stop
    // publication, rather than being mistaken for permission to create one.
    if (error.status === 1 && /HTTP 404/.test(String(error.stderr))) return null;
    throw error;
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

function publish(dir) {
  if (process.env.GITHUB_REPOSITORY !== REPO || process.env.GITHUB_REF !== "refs/heads/test") {
    throw new Error("Test publication must run from therexdev/kaiapp:test");
  }
  const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
    if (!/^\d+\.\d+\.\d+-test\.\d+\.\d+$/.test(version)) throw new Error("Invalid test version");
    const binaries = names.filter(n => /^Koinos-AI-Test-.*\.(exe|AppImage|blockmap)$/.test(n));
    if (!binaries.some(n => /^Koinos-AI-Test-Setup-.*\.exe$/.test(n))) throw new Error("Windows installer missing");
    const sums = binaries.map(n => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, n))).digest("hex")}  ${n}`).join("\n") + "\n";
    const checksum = path.join(temp, `SHA256SUMS-${version}`);
    fs.writeFileSync(checksum, sums);
    const provenance = path.join(temp, `build-${version}.json`);
    fs.writeFileSync(provenance, JSON.stringify({ version, commit: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID, stableCompatibility: latest.tag_name }, null, 2) + "\n");
    const body = path.join(temp, "notes.md");
    const setup = binaries.find(n => /^Koinos-AI-Test-Setup-.*\.exe$/.test(n));
    fs.writeFileSync(body, `## Koinos AI Test ${version}\n\n[Download the Windows test installer](https://github.com/${REPO}/releases/download/${TAG}/${setup})\n\nInstalls alongside Koinos AI with separate chats, settings, wallet files and models. Test updates stay on this channel. Local API: port 41101.\n\nThis is a test APP, connected to the existing network services; it is not a separate blockchain or scheduler. Start with a new test profile.\n\nSource commit: ${process.env.GITHUB_SHA}\nBuild: https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}\n\nThe rolling tag identifies this download channel. The versioned build JSON and checksums identify each build's exact source and files. Older versioned binaries remain here for in-flight downloads. The latest*.yml files are compatibility pointers to live ${latest.tag_name}, never test installers.\n`);
    const existing = findTestRelease(gh);
    if (!existing) {
      gh("release", "create", TAG, "--repo", REPO, "--target", process.env.GITHUB_SHA,
        "--draft", "--prerelease", "--latest=false", "--title", "Koinos AI Test", "--notes-file", body);
    } else if (!existing.prerelease) {
      throw new Error("test-build must remain a prerelease");
    }
    // Binaries first, feeds last. Retain old versioned binaries so an app
    // already downloading a previous build can finish during publication.
    gh("release", "upload", TAG, "--repo", REPO, ...binaries.map(n => path.join(dir, n)), checksum, provenance, "--clobber");
    gh("release", "upload", TAG, "--repo", REPO, ...compatibility, "--clobber");
    gh("release", "upload", TAG, "--repo", REPO, ...feeds.map(n => path.join(dir, n)), "--clobber");
    gh("release", "edit", TAG, "--repo", REPO, "--draft=false", "--prerelease", "--latest=false",
      "--title", `Koinos AI Test ${version}`, "--notes-file", body);
    console.log(`Published Test ${version}; live remains ${latest.tag_name}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

if (require.main === module) publish(path.resolve(process.argv[2] || "artifacts"));
module.exports = { stableCompatibility, findTestRelease };
