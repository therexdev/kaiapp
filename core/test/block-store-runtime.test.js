"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto"), yaml = require("js-yaml");
const { NodeManager } = require("../lib/koinos/node-manager");
const { PATCH, VERSION, UPSTREAM, FILES, verifyBundle, patchedCompose } = require("../lib/koinos/block-store-runtime");
const { checkHistory } = require("../lib/koinos/history-check");
const MAINNET = "EiBZK_GGVP0H_fXVAM3j6EAuz3-B-l3ejxRSewi7qIBfSA==";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, "bundle"); fs.mkdirSync(bundle);
  const files = FILES.map(name => { const data = `fixture-${name}`; fs.writeFileSync(path.join(bundle, name), data); return { name, sha256: crypto.createHash("sha256").update(data).digest("hex") }; });
  fs.writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify({ schemaVersion: 1, patch: PATCH, version: VERSION, upstreamCommit: UPSTREAM, platform: "linux/amd64", files }));
  return { root, bundle };
}
test("LF, Windows CRLF and mixed Compose templates produce the same patched services", () => {
  const source = fs.readFileSync(path.join(__dirname, "../koinos-node-template/docker-compose.yml"), "utf8").replace(/\r\n?/g, "\n");
  const expected = yaml.load(patchedCompose(source));
  for (const input of [source.replace(/\n/g, "\r\n"), source.replace(/\n/g, "\r"), source.replace(/volumes:\n/g, "volumes:\r\n")]) {
    assert.deepEqual(yaml.load(patchedCompose(input)), expected);
  }
  const original = yaml.load(source);
  for (const service of Object.keys(original.services).filter(name => name !== "block_store")) {
    assert.deepEqual(expected.services[service], original.services[service]);
  }
  assert.deepEqual(expected.configs, original.configs);
  assert.throws(() => patchedCompose(source.replace("   block_store:", "   unrelated_store:")), /Unexpected block-store Compose template/);
});
test("Windows template can start the patched node while retaining paused history and existing data", async t => {
  const { root, bundle } = fixture(t), templateRoot = path.join(root, "template");
  fs.cpSync(path.join(__dirname, "../koinos-node-template"), templateRoot, { recursive: true });
  const file = path.join(templateRoot, "docker-compose.yml");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"));
  const mgr = new NodeManager({ dataRoot: path.join(root, "node"), templateRoot, runtimeBundle: bundle, platform: "win32" });
  const d = mgr.dirs("mainnet"); fs.mkdirSync(d.basedir, { recursive: true });
  fs.writeFileSync(path.join(d.basedir, "existing-data"), "preserve");
  const calls = []; mgr._composeOp = async (...args) => { calls.push(args); }; mgr._startWatchdog = () => {};
  await mgr.start("mainnet", null);
  assert.deepEqual(calls, [["mainnet", "start", ["up", "-d", "--remove-orphans"]]]);
  const compose = yaml.load(fs.readFileSync(path.join(d.root, "docker-compose.yml"), "utf8"));
  assert.equal(compose.services.block_store.labels["io.koinosai.block-store.patch"], PATCH);
  assert.equal(fs.readFileSync(path.join(d.basedir, "existing-data"), "utf8"), "preserve");
  assert.ok(!fs.readFileSync(path.join(d.root, ".env"), "utf8").includes("account_history"));
  assert.equal(yaml.load(fs.readFileSync(path.join(d.config, "config.yml"), "utf8")).chain["verify-blocks"], true);
});
test("Master stages a verified patch on normal start and recovery while preserving data and paused profiles", async t => {
  const { root, bundle } = fixture(t);
  const mgr = new NodeManager({ dataRoot: path.join(root, "node"), runtimeBundle: bundle, templateRoot: path.join(__dirname, "../koinos-node-template") });
  const d = mgr.dirs("mainnet"); fs.mkdirSync(d.basedir, { recursive: true });
  fs.writeFileSync(path.join(d.basedir, "existing-data"), "chain and keys");
  mgr._composeOp = async () => {}; mgr._startWatchdog = () => {};
  await mgr.start("mainnet", null);
  const check = () => {
    const compose = yaml.load(fs.readFileSync(path.join(d.root, "docker-compose.yml"), "utf8"));
    assert.deepEqual(compose.services.block_store.entrypoint, ["/bin/sh", "/kai-block-store/start.sh"]);
    assert.equal(compose.services.block_store.labels["io.koinosai.block-store.patch"], PATCH);
    assert.ok(compose.services.block_store.volumes.includes("${BASEDIR}:/koinos"));
    assert.ok(compose.services.block_store.volumes.includes("./block-store-runtime:/kai-block-store:ro"));
    assert.equal(compose.services.block_store.command, "--basedir=/koinos");
    assert.equal(fs.readFileSync(path.join(d.basedir, "existing-data"), "utf8"), "chain and keys");
    assert.ok(!fs.readFileSync(path.join(d.root, ".env"), "utf8").includes("account_history"));
    assert.equal(verifyBundle(path.join(d.root, "block-store-runtime")).patch, PATCH);
  };
  check();
  mgr._compose = async () => ({ ok: true });
  const w = { networkId: "mainnet", producerAddress: null, memorySaver: false }; mgr._watch = w;
  assert.equal(await mgr._restartStack(w), true); check();
  mgr.ensureFiles("harbinger", null);
  const testnet = fs.readFileSync(path.join(mgr.dirs("harbinger").root, "docker-compose.yml"), "utf8");
  assert.ok(!testnet.includes("/kai-block-store"));
});
test("changed binaries, wrappers or manifests fail before staging a runtime", t => {
  const { bundle } = fixture(t);
  for (const name of FILES) {
    const file = path.join(bundle, name), original = fs.readFileSync(file);
    fs.appendFileSync(file, "changed"); assert.throws(() => verifyBundle(bundle), /checksum failed/); fs.writeFileSync(file, original);
  }
  const file = path.join(bundle, "manifest.json"), manifest = JSON.parse(fs.readFileSync(file));
  manifest.upstreamCommit = "other"; fs.writeFileSync(file, JSON.stringify(manifest));
  assert.throws(() => verifyBundle(bundle), /Invalid.*manifest/);
  assert.throws(() => verifyBundle(path.join(bundle, "missing")), /ENOENT/);
});

function historyFixture() {
  const calls = [], commands = [];
  const nodeMgr = { _compose: async (...args) => { commands.push(args); return { ok: true, stdout: `Koinos Block Store v1.1.0 (${VERSION})` }; }, logs: async () => "Sync progress - Height: 2346000" };
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "chain.get_chain_id") return { chain_id: MAINNET };
    if (method === "chain.get_head_info") return { head_topology: { height: "39544000", id: "head" }, last_irreversible_block: "39543940", head_block_time: Date.now() };
    const height = params.ancestor_start_height;
    return { block_items: [{ block_height: height, block_id: "block"+height, block: { id: "block"+height, header: { height } }, receipt: { id: "block"+height } }] };
  };
  return { nodeMgr, call, calls, commands };
}
test("history diagnostic refuses unpatched services without reading historical data", async () => {
  const f = historyFixture(); f.nodeMgr._compose = async () => ({ ok: false, stdout: "" });
  await assert.rejects(checkHistory(f), /patch is not running/); assert.equal(f.calls.length, 0);
});
test("history diagnostic is bounded, local, read-only and never certifies complete history", async () => {
  const f = historyFixture(), result = await checkHistory(f);
  assert.equal(result.samplesAvailable, true); assert.equal(result.complete, false);
  assert.equal(result.lastLoggedHeight, 2346000); assert.ok(result.samples.some(s => s.height === 2346001));
  assert.ok(result.samples.some(s => s.height === 2347000));
  assert.ok(result.samples.length <= 8);
  assert.deepEqual(f.commands[0][1], ["exec", "-T", "block_store", "/tmp/kai_koinos_block_store", "--version"]);
  for (const c of f.calls.filter(c => c.params)) { assert.equal(c.params.num_blocks, 1); assert.equal(c.params.return_receipt, true); assert.equal(c.params.head_block_id, "head"); }
});
test("first missing block/receipt stops the diagnostic and keeps history unready", async () => {
  for (const kind of ["error", "receipt", "wrong-id"]) {
    const f = historyFixture(); const original = f.call;
    f.call = async (method, params) => {
      const value = await original(method, params);
      if (params?.ancestor_start_height === "1000000") {
        if (kind === "error") throw new Error("Block not present - ID: 0x1220abcdef");
        if (kind === "receipt") delete value.block_items[0].receipt;
        if (kind === "wrong-id") value.block_items[0].receipt.id = "different";
      }
      return value;
    };
    const result = await checkHistory(f);
    assert.equal(result.samplesAvailable, false); assert.equal(result.complete, false);
    assert.equal(result.samples.length, 2); assert.equal(result.samples[1].available, false);
  }
});
test("wrong chain or stale head prevents historical queries", async () => {
  for (const kind of ["chain", "stale"]) {
    const f = historyFixture(); const original = f.call;
    f.call = async (method, params) => { const value = await original(method, params);
      if (kind === "chain" && value.chain_id) value.chain_id = "wrong";
      if (kind === "stale" && value.head_block_time) value.head_block_time -= 120000;
      return value;
    };
    await assert.rejects(checkHistory(f), /Mainnet/);
    assert.ok(f.calls.every(c => !c.method.startsWith("block_store")));
  }
});
