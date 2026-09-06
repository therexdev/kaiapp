"use strict";
const { execFileSync } = require("child_process");
const pkg = require("../package.json");
if (pkg.kaiChannel === "test" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Live releases need a stable version");
const { GITHUB_REPOSITORY: repo, GITHUB_SHA: sha } = process.env;
if (repo !== "therexdev/kaiapp" || !/^[0-9a-f]{40}$/.test(sha || "")) throw new Error("Expected GitHub release context");
const api = (...args) => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8" }));
const tag = `v${pkg.version}`;
const refs = api(`repos/${repo}/git/matching-refs/tags/${tag}`);
const existing = refs.find(r => r.ref === `refs/tags/${tag}`);
if (existing) {
  if (existing.object.sha !== sha) throw new Error(`${tag} already identifies another commit; choose a new version`);
} else {
  api(`repos/${repo}/git/refs`, "--method", "POST", "-f", `ref=refs/tags/${tag}`, "-f", `sha=${sha}`);
}
console.log(`${tag} identifies ${sha}`);
