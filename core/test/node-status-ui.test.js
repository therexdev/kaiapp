"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../../ui/knode/renderer.js"), "utf8");

// Execute the shipping painters against their DOM boundary, without starting
// Docker, accessing a wallet, or depending on a live chain or browser install.
function painter() {
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", innerHTML: "", className: "", dataset: {}, addEventListener() {} });
    return nodes.get(id);
  };
  const S = {
    node: { docker: { ok: true }, isRunning: false, runningCount: 0, services: [], autoRecover: true },
    producer: { address: "fixture", filePublicKey: "fixture-key", matches: true },
    producerBalances: { vhp: "100000000" }, walletStage: "locked", dashboardRendered: true,
  };
  const context = vm.createContext({ S, $, ONE: 100000000n, sym: () => "KOIN" });
  for (const name of ["esc", "fmtSat", "fmtTime", "fmtPct", "fmtBytes", "tile", "quickSyncStage", "patchNodeView", "patchDashboardView"]) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `shipping function ${name} exists`);
    const remainder = source.slice(start);
    const end = remainder.search(/\n(?:async )?function \w+\(/);
    vm.runInContext(end < 0 ? remainder : remainder.slice(0, end), context);
  }
  const paint = () => {
    S.dashboard = { network: { label: "Mainnet", tokenSymbol: "KOIN" }, node: S.node,
      wallet: { exists: false }, sync: { inSync: true, local: { height: 100 }, progressPct: 100 } };
    vm.runInContext("patchNodeView(); patchDashboardView();", context);
  };
  return { S, $, paint };
}

test("snapshot restore stays distinct from running, even with stale healthy/synced data", () => {
  const { S, $, paint } = painter();
  S.node.health = { ok: true, memorySaver: true };
  for (const stage of ["starting", "stopping", "download", "verify", "inspect", "extract", "install", "cleanup"]) {
    S.node.op = { name: "quick-sync", running: true, progress: { stage, pct: 2.8 }, tail: [] };
    S.node.isRunning = stage === "starting" || stage === "stopping";
    paint();
    assert.equal($("#d-status-text").textContent, "Quick syncing");
    assert.equal($("#d-dot").className, "dot amber");
    assert.equal($("#d-toggle").disabled, true);
    assert.equal($("#d-sync").innerHTML, "", "stale live-sync data is suppressed during restore");
    for (const id of ["#n-start", "#n-stop", "#n-quicksync"]) assert.equal($(id).disabled, true);
    assert.match($("#n-sync").innerHTML, /after the restore/);
    assert.doesNotMatch($("#n-health").innerHTML, /healthy|up and earning/);
    assert.match($("#n-reg-hint").textContent, /paused for quick sync/);
    assert.equal($("#n-autorecover").checked, true, "the saved preference is preserved");
  }
});

test("completion, cancellation, and failure return to stopped controls without claiming production", () => {
  const { S, $, paint } = painter();
  for (const result of [{ code: 0 }, { code: 1, error: "Cancelled" }, { code: 1, error: "Download failed" }]) {
    S.node.op = { name: "quick-sync", running: false, progress: { stage: "done" }, tail: [], ...result };
    paint();
    assert.equal($("#n-run-pill").textContent, "stopped");
    assert.equal($("#d-status-text").textContent, "Offline");
    assert.equal($("#d-dot").className, "dot red");
    assert.equal($("#d-toggle").disabled, false);
    assert.equal($("#d-toggle").dataset.action, "start");
    assert.equal($("#n-start").disabled, false);
    assert.match($("#n-reg-hint").textContent, /no blocks are being produced/);
  }
});

test("a running node uses a single indicator and keeps registration separate from production", () => {
  const { S, $, paint } = painter();
  S.node.isRunning = true; S.node.runningCount = 7;
  paint();
  assert.equal($("#d-status-text").textContent, "Running");
  assert.equal($("#d-dot").className, "dot green");
  assert.equal($("#d-toggle").dataset.action, "stop");
  assert.match($("#n-reg-hint").textContent, /requires an in-sync node/);
  S.producer.mode = "external"; S.node.isRunning = false;
  paint();
  assert.match($("#n-reg-hint").textContent, /External producer registration verified/);
  assert.match($("#n-reg-hint").textContent, /no blocks are being produced/);
});

test("node screen shows only the action opposite its running state", () => {
 const {S,$,paint}=painter();
 for (const running of [false,true,false]) {
  S.node.isRunning=running;paint();
  assert.equal($("#n-start").hidden,running);assert.equal($("#n-stop").hidden,!running);
 }
 S.node.op={name:"start",running:true,tail:[]};paint();
 assert.equal($("#n-start").disabled,true);assert.equal($("#n-stop").disabled,true);
});
