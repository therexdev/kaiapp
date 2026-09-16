"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { readVerifiedArtifacts } = require("./windows-signing");

const dir = path.resolve(process.argv[2] || "dist");
if (process.env.GITHUB_REPOSITORY !== "therexdev/kaiapp" ||
    !(process.env.GITHUB_REF === "refs/heads/claude/koinos-ai-takeover-co25fw" || /^refs\/tags\/v\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF || ""))) {
  throw new Error("Windows live publication requires the live desktop release branch or a stable tag");
}
const { report, reportFile, names } = readVerifiedArtifacts(dir, {
  commit: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID,
});
if (!/^\d+\.\d+\.\d+$/.test(report.version)) throw new Error("Test installers cannot be published as live");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-windows-release-"));
try {
  // Match electron-builder's GitHub-safe download names without modifying bytes.
  const files = [...names, reportFile].map(name => {
    const dest = path.join(temp, name.replace(/ /g, "-"));
    fs.copyFileSync(path.join(dir, name), dest);
    return dest;
  });
  const upload = list => execFileSync("gh", ["release", "upload", `v${report.version}`, "--repo", "therexdev/kaiapp", ...list], { stdio: "inherit" });
  // Never expose the update feed until every verified binary and report is up.
  upload(files.filter(f => !f.endsWith(".yml")));
  upload(files.filter(f => f.endsWith(".yml")));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
