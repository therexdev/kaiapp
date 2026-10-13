"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { NodeManager, buildEnv } = require("../lib/koinos/node-manager");
const { CORE_SERVICES, assessHealth } = require("../lib/koinos/node-health");
const { claimProject, canonicalPath, inspectOwner } = require("../lib/koinos/node-control");
const { NETWORKS } = require("../lib/koinos/constants");
const yaml = require("js-yaml");

function fixture(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-supervisor-"));
  const mgr = new NodeManager({ dataRoot: path.join(root, "node"), intentPath: path.join(root, "intent.json"),
    lockRoot: path.join(root, "locks"), templateRoot: path.join(__dirname, "../koinos-node-template"), ...opts });
  const d = mgr.ensureFiles("mainnet", null);
  const host = { owner: d.root, available: true, logs: "", rows: CORE_SERVICES.map((service, i) => ({
    ID: (i + 1).toString(16).repeat(64), Service: service, State: "running", Health: service === "amqp" ? "healthy" : "" })) };
  const mutations = [];
  mgr._exec = async (_bin, args) => {
    if (!host.available) return { ok: false, stderr: "Docker unavailable", stdout: "" };
    if (args[0] === "ps") return { ok: true, stdout: host.rows.map(r => r.ID).join("\n") };
    if (args[0] === "inspect") {
      if (args[2].includes(".Config.Labels")) return { ok: true, stdout: host.rows.map(() => JSON.stringify(host.owner)).join("\n") };
      return { ok: true, stdout: host.rows.map(r => JSON.stringify({ id: r.ID, startedAt: new Date(Date.now()-600000).toISOString(), oomKilled: false })).join("\n") };
    }
    if (args.includes("version")) return { ok: true, stdout: "v2" };
    if (args.includes("info")) return { ok: true, stdout: "27" };
    const command = args[args.indexOf("-f") + 2];
    if (command === "ps") return { ok: true, stdout: JSON.stringify(host.rows) };
    if (command === "logs") return { ok: true, stdout: host.logs, stderr: "" };
    mutations.push(args.slice(args.indexOf("-f") + 2));
    return { ok: true, stdout: "", stderr: "" };
  };
  t.after(() => { mgr.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { mgr, host, mutations, root, d };
}
function watch(mgr) {
  mgr._desiredRunning = true; mgr._startWatchdog("mainnet", false, null, false);
  mgr._watch.graceUntil = 0; return mgr._watch;
}

test("Master's Docker labels block Test start, stop, repair, Quick Sync and adoption", async t => {
  const { mgr, host, mutations, d } = fixture(t);
  host.owner = "C:\\Users\\admin\\Master Koinos AI Node\\node\\mainnet";
  const before = fs.readFileSync(path.join(d.root, "docker-compose.yml"), "utf8");
  for (const action of [() => mgr.start("mainnet", null), () => mgr.stop("mainnet"), () => mgr.repair("mainnet"), () => mgr.quickSync("mainnet")]) {
    await assert.rejects(action(), /belongs to another KAI profile/);
  }
  mgr._desiredRunning = null;
  const status = await mgr.status("mainnet");
  assert.equal(status.control.reason, "managed-elsewhere"); assert.equal(mgr._watch, null);
  assert.equal(fs.readFileSync(path.join(d.root, "docker-compose.yml"), "utf8"), before);
  assert.deepEqual(mutations, []);
});

test("same-project controllers cannot race even before containers exist", t => {
  const { root } = fixture(t), options = { lockRoot: path.join(root, "exclusive") };
  const release = claimProject("koinos-desktop-mainnet", options);
  assert.throws(() => claimProject("koinos-desktop-mainnet", options), /Another KAI/);
  release(); const next = claimProject("koinos-desktop-mainnet", options); next(); release();
});

test("a foreign-profile observation prevents stealing its project during a later restart gap", async t => {
  const { mgr, host, mutations } = fixture(t);
  mgr._saveIntent("mainnet", true); const w = watch(mgr);
  host.owner = "/another-profile/mainnet"; await mgr._watchTick();
  assert.equal(mgr._intent.mainnet.blockedByOtherProfile, true);
  host.rows = []; await mgr._watchTick();
  assert.equal(w.health.reason, "managed-elsewhere"); assert.deepEqual(mutations, []);
  assert.equal(JSON.parse(fs.readFileSync(mgr.intentPath)).mainnet.blockedByOtherProfile, true);
});

test("network parse errors and database locks never request a data rebuild", () => {
  const { classifyCrash } = require("../lib/koinos/node-health");
  for (const log of ["malformed peer request", "truncated network response", "failed to open database: resource temporarily unavailable"])
    assert.equal(classifyCrash(log), null);
  assert.equal(classifyCrash("Corruption: block checksum mismatch"), "corruption");
  assert.equal(classifyCrash("RocksDB table checksum mismatch"), "corruption");
});

test("ownership is fail closed for missing labels and handles Windows Docker path spellings", async () => {
  assert.equal(canonicalPath("C:\\Users\\Mike\\Node\\"), canonicalPath("/run/desktop/mnt/host/c/Users/Mike/Node"));
  for (const label of [null, "", 42]) {
    const result = await inspectOwner(async (_b, args) => ({ ok: true, stdout: args[0] === "ps" ? "a".repeat(64) : JSON.stringify(label) }), "koinos-desktop-mainnet", "/node");
    assert.equal(result.ok, false); assert.equal(result.reason, "ownership-unknown");
  }
});

test("a vanished complete stack is recreated without a resync", async t => {
  const { mgr, host, mutations, d } = fixture(t); host.rows = [];
  fs.writeFileSync(path.join(d.basedir, "retained-chain"), "block data");
  const w = watch(mgr); await mgr._watchTick();
  assert.equal(w.needsRepair, false);
  assert.deepEqual(mutations, [["up", "-d", "--remove-orphans"]]);
  assert.equal(fs.readFileSync(path.join(d.basedir, "retained-chain"), "utf8"), "block data");
});

test("Docker outage launches only the installed engine with cooldown and no compose changes", async t => {
  const { mgr, host, mutations } = fixture(t); const w = watch(mgr); host.available = false;
  let launches = 0; mgr.startDocker = async () => { launches++; };
  await mgr._watchTick(); await mgr._watchTick();
  assert.equal(launches, 1); assert.equal(w.health.reason, "docker-unavailable"); assert.deepEqual(mutations, []);
  host.available = true; host.rows = []; await mgr._watchTick();
  assert.equal(mutations[0][0], "up");
});

test("closed Node screen and an app restart retain run intent; explicit Stop disables resume", async t => {
  const { mgr, host, root, mutations } = fixture(t);
  mgr._saveIntent("mainnet", true, null, false); mgr.dispose(); host.rows = [];
  const resumed = new NodeManager({ dataRoot: mgr.dataRoot, intentPath: mgr.intentPath, lockRoot: path.join(root, "locks"), templateRoot: mgr.templateRoot });
  resumed._exec = mgr._exec; t.after(() => resumed.dispose());
  resumed.supervise(() => "mainnet"); await new Promise(r => setImmediate(r));
  assert.equal(resumed._desiredRunning, true);
  resumed._watch.graceUntil = 0; await resumed.nudge();
  assert.equal(mutations.at(-1)[0], "up");
  resumed._composeOp = async () => ({ code: 0 });
  await resumed.stop("mainnet");
  assert.equal(JSON.parse(fs.readFileSync(mgr.intentPath)).mainnet.running, false);
  resumed.dispose();
  const stopped = new NodeManager({ dataRoot: mgr.dataRoot, intentPath: mgr.intentPath });
  t.after(() => stopped.dispose()); stopped.status = async () => assert.fail("explicit Stop must not adopt or restart");
  stopped.supervise(() => "mainnet"); await stopped.nudge(); assert.equal(stopped._watch, null);
});

test("a disconnected data drive is never replaced by a newly initialized chain", async t => {
  const { mgr, d, mutations } = fixture(t); const w = watch(mgr);
  fs.rmSync(d.root, { recursive: true }); await mgr._watchTick();
  assert.equal(w.health.reason, "data-unavailable"); assert.deepEqual(mutations, []); assert.equal(fs.existsSync(d.root), false);
});

test("RPC repair restarts only jsonrpc and keeps advancing chain and producer data", async t => {
  const { mgr, mutations, d } = fixture(t, { probeHead: async () => null });
  fs.writeFileSync(path.join(d.basedir, "preserve"), "producer keys and chain");
  const w = watch(mgr);
  await mgr._watchTick(); assert.equal(w.health.reason, "rpc-unavailable");
  await mgr._watchTick();
  assert.deepEqual(mutations, [["up", "-d", "--no-deps", "--force-recreate", "jsonrpc"]]);
  assert.equal(fs.readFileSync(path.join(d.basedir, "preserve"), "utf8"), "producer keys and chain");
});

test("recent chain log progress protects catch-up from a full-stack restart when RPC is wedged", async t => {
  const { mgr, host, mutations } = fixture(t, { probeHead: async () => null });
  const w = watch(mgr); w.lastHeightAt = Date.now()-15*60000; w.probeFailures = 2;
  host.logs = `chain-1 | ${new Date().toISOString()} Sync progress - Height: 40170000`;
  await mgr._watchTick();
  assert.deepEqual(mutations, [["up", "-d", "--no-deps", "--force-recreate", "jsonrpc"]]);
});

test("full service repair never removes data and Stop can cancel it", async t => {
  const { mgr, mutations } = fixture(t); const w = watch(mgr);
  assert.equal(await mgr._restartStack(w, { reason: "manual-repair" }), true);
  assert.deepEqual(mutations, [["stop", "--timeout", "120"], ["up", "-d", "--remove-orphans"]]);
  assert.ok(!mutations.some(args => args.includes("down") || args.includes("--volumes")));
});

test("shutdown stops the supervisor without changing persisted running intent", async t => {
  const { mgr } = fixture(t); mgr._saveIntent("mainnet", true); watch(mgr);
  await mgr._assertControl("mainnet"); assert.equal(mgr.shouldKeepAwake(), true);
  mgr.dispose(); assert.equal(mgr.shouldKeepAwake(), false);
  assert.equal(JSON.parse(fs.readFileSync(mgr.intentPath)).mainnet.running, true);
  await assert.rejects(mgr._assertControl("mainnet"), /closed/);
});

test("enabled API indexes participate in health and memory saver retains the RPC", () => {
  const services = CORE_SERVICES.map(service => ({ service, state: "running" }));
  assert.equal(assessHealth({ services, extraServices: ["account_history"] }).service, "account_history");
  assert.match(buildEnv(NETWORKS.mainnet, "/node", true, true, true, true), /COMPOSE_PROFILES=jsonrpc,block_producer/);
});

test("all services get bounded Docker logs and graceful database shutdown time", t => {
  const { d } = fixture(t);
  const compose = yaml.load(fs.readFileSync(path.join(d.root, "docker-compose.yml"), "utf8"));
  for (const [name, service] of Object.entries(compose.services)) {
    assert.equal(service.restart, "always", name); assert.equal(service.stop_grace_period, "120s", name);
    assert.deepEqual(service.logging.options, { "max-size": "10m", "max-file": "3" }, name);
  }
});
