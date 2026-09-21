"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert/strict");
const { execFileSync, spawnSync } = require("child_process");
const pkg = path.resolve("build/history-repair"), fixture = path.resolve(process.env.KAI_REPAIR_SMOKE_FIXTURE);
const backup = path.join(fixture, "backups");
fs.mkdirSync(backup, { recursive: true });
// The upstream service runs as UID 0. Match that ownership on the disposable
// fixture: cap-drop ALL deliberately prevents UID 0 overriding another
// owner's private files. Do not relax the repair container's capabilities.
if (process.getuid() !== 0) execFileSync("sudo", ["chown", "-R", "0:0", fixture]);
const options = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "0:0", "--tmpfs", "/tmp:rw,exec,size=64m", "--mount", `type=bind,source=${pkg},target=/repair,readonly`, "--entrypoint", "/bin/sh"];
const launch = "cp /repair/kai_history_repair /tmp/kai_history_repair && chmod 700 /tmp/kai_history_repair && exec /tmp/kai_history_repair";
// Badger's ReadOnly option protects logical records but the pinned version
// still opens its DISCARD housekeeping file with O_RDWR.
const run = args => execFileSync("docker", [...options, "--mount", `type=bind,source=${path.join(fixture, "db")},target=/database`, "--mount", `type=bind,source=${backup},target=/backups`, "koinos/koinos-block-store:v1.1.0", "-c", `${launch} --db /database ${args}`], { encoding: "utf8" });
assert.match(run("--check"), /CHECK PASSED/);
const output = run("--repair --backup /backups/before.bak");
assert.match(output, /REPAIR COMPLETE/);
process.stdout.write(output);
const repeat = spawnSync("docker", [...options, "--mount", `type=bind,source=${path.join(fixture, "db")},target=/database`, "koinos/koinos-block-store:v1.1.0", "-c", `${launch} --db /database --check`], { encoding: "utf8" });
assert.notEqual(repeat.status, 0); assert.match(repeat.stderr, /target record already exists/);
console.log("Original-container smoke passed: check-only preflight, full backup, one-record repair, and overwrite refusal.");
