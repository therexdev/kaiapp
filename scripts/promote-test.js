"use strict";

// Owner-authorized promotion. Run from a clean, tested test branch with git
// push access and an authenticated GitHub CLI. Nothing force-pushes a branch.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const semver = require("semver");
const root = path.join(__dirname, "..");
const live = "claude/koinos-ai-takeover-co25fw";
const run = (bin, args) => execFileSync(bin, args, { cwd: root, encoding: "utf8" }).trim();
const git = (...args) => run("git", args);
const version = process.argv[2];
if (!semver.valid(version) || semver.prerelease(version)) throw new Error("Usage: npm run promote:test -- <stable-version>");
if (git("branch", "--show-current") !== "test" || git("status", "--porcelain")) throw new Error("Start on a clean test branch");
git("fetch", "origin", "test", live);
const sha = git("rev-parse", "HEAD");
if (sha !== git("rev-parse", "origin/test")) throw new Error("Local test must match the pushed test branch");
git("merge-base", "--is-ancestor", `origin/${live}`, sha);
const runs = JSON.parse(run("gh", ["api", `repos/therexdev/kaiapp/actions/workflows/test-release.yml/runs?head_sha=${sha}&per_page=20`])).workflow_runs;
if (!runs.some(r => r.head_sha === sha && r.conclusion === "success")) throw new Error("This commit needs a successful Test installers run");
const release = JSON.parse(run("gh", ["api", "repos/therexdev/kaiapp/releases/latest"]));
if (!semver.gt(version, release.tag_name.replace(/^v/, ""))) throw new Error("Choose a version newer than live");
const branch = `release/${version}`;
git("switch", "-c", branch);
run(process.execPath, ["core/scripts/set-version.js", version]);
// Keep npm's workspace lock metadata consistent with both package files.
const lockFile = path.join(root, "package-lock.json");
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
lock.version = version;
lock.packages[""].version = version;
lock.packages.core.version = version;
fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
run(process.execPath, ["--test", "core/test/version.test.js", "core/test/release-channel.test.js"]);
git("add", "package.json", "core/package.json", "package-lock.json");
git("commit", "-m", `[release] v${version}: promote tested KAI changes`);
git("push", "origin", `HEAD:${live}`);
git("switch", "test");
git("merge", "--ff-only", branch);
git("push", "origin", "test");
console.log(`Live build started for ${version}; check CI and published assets before calling it released.`);
