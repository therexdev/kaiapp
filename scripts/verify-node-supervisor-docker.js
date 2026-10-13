"use strict";
// Disposable Docker integration fixture. No real chain, wallet, producer,
// published ports or production Compose project. Exercises the shipping manager.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { NodeManager } = require("../core/lib/koinos/node-manager");
const { CORE_SERVICES } = require("../core/lib/koinos/node-health");
const { NETWORKS } = require("../core/lib/koinos/constants");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-docker-recovery-"));
  const project = `kai-recovery-test-${process.pid}-${Date.now()}`;
  const original = NETWORKS.mainnet.composeProject;
  const templateRoot = path.join(root, "template");
  fs.cpSync(path.join(__dirname, "../core/koinos-node-template"), templateRoot, { recursive: true });
  fs.writeFileSync(path.join(templateRoot, "docker-compose.yml"), "services:\n" + CORE_SERVICES.map(name =>
    `  ${name}:\n    image: alpine:3.21\n    command: [\"sleep\", \"600\"]\n    volumes:\n      - \"${'${BASEDIR}'}:/data\"\n`).join(""));
  NETWORKS.mainnet.composeProject = project;
  const options = { templateRoot, dataRoot: path.join(root, "owner"), intentPath: path.join(root, "intent.json"), lockRoot: path.join(root, "locks"), probeHead: async () => 100,
    runtimeBundle: path.join(root, "no-patched-runtime") };
  let mgr = new NodeManager(options), other;
  const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"] });
  const compose = args => docker(["compose", "-p", project, "-f", path.join(mgr.dirs("mainnet").root, "docker-compose.yml"), ...args]);
  try {
    await mgr.start("mainnet", null); await mgr._commandPending;
    assert.equal(mgr.currentOp().code, 0, mgr.currentOp().error);
    const originalRows = await mgr.services("mainnet"); assert.equal(originalRows.length, CORE_SERVICES.length);
    const marker = path.join(mgr.dirs("mainnet").basedir, "preserve.txt"); fs.writeFileSync(marker, "chain data sentinel");
    const chainId = originalRows.find(r => r.service === "chain").id;
    const rpcId = originalRows.find(r => r.service === "jsonrpc").id;
    compose(["stop", "jsonrpc"]);
    mgr._watch.graceUntil = 0; await mgr._watchTick();
    assert.equal(mgr._watch.lastRecoveryError, null);
    const repaired = await mgr.services("mainnet");
    assert.equal(repaired.find(r => r.service === "chain").id, chainId, "RPC failure must not restart chain");
    assert.notEqual(repaired.find(r => r.service === "jsonrpc").id, rpcId);
    assert.equal(repaired.find(r => r.service === "jsonrpc").state, "running");
    // Simulate the owner app exiting, leaving Docker running. Other profiles
    // still cannot take the node, even without the owner's process lease.
    mgr.dispose();
    other = new NodeManager({ ...options, dataRoot: path.join(root, "other"), intentPath: path.join(root, "other-intent.json") });
    await assert.rejects(other.start("mainnet", null), /belongs to another KAI profile/);
    other.dispose();
    mgr = new NodeManager(options);
    mgr.supervise(() => "mainnet");
    while (mgr._supervising) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(mgr._desiredRunning, true, "reopen must resume supervision");
    compose(["down"]);
    mgr._watch.graceUntil = 0; await mgr._watchTick();
    assert.equal(mgr._watch.lastRecoveryError, null);
    assert.equal((await mgr.services("mainnet")).filter(r => r.state === "running").length, CORE_SERVICES.length);
    assert.equal(fs.readFileSync(marker, "utf8"), "chain data sentinel");
    await mgr.stop("mainnet"); await mgr._commandPending;
    assert.equal(JSON.parse(fs.readFileSync(options.intentPath)).mainnet.running, false);
    assert.equal((await mgr.services("mainnet")).length, 0);
    console.log("PASS: real Compose ownership, single-service recovery, app reopen, absent-stack recovery, retained data and explicit Stop.");
  } finally {
    mgr.dispose(); other?.dispose();
    try { compose(["down", "--remove-orphans", "--timeout", "10"]); } catch {}
    NETWORKS.mainnet.composeProject = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
