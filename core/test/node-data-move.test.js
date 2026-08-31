"use strict";

/*
 * The chain data move, tested for the property that actually matters: the
 * original survives everything except a verified, completed copy.
 *
 * These are not "does it copy files" tests. Copying files is easy. What is
 * hard, and what loses somebody's 50 GB synced node, is the ordering — and
 * ordering is only visible when something goes wrong halfway. So most of what
 * is below breaks the move on purpose and then checks the source is intact.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const dataMove = require("../lib/koinos/data-move");
const { NodeManager } = require("../lib/koinos/node-manager");

function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kai-move-${label}-`));
}

/** A stand-in chain directory: nested, a few files, known sizes. */
function seedChain(root) {
  const base = path.join(root, "mainnet", "basedir");
  fs.mkdirSync(path.join(base, "chain", "db"), { recursive: true });
  fs.mkdirSync(path.join(root, "mainnet", "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "mainnet", "docker-compose.yml"), "services: {}\n");
  fs.writeFileSync(path.join(root, "mainnet", ".env"), `BASEDIR=${base}\n`);
  fs.writeFileSync(path.join(root, "mainnet", "config", "config.yml"), "chain: {}\n");
  fs.writeFileSync(path.join(base, "chain", "db", "000001.sst"), "x".repeat(4096));
  fs.writeFileSync(path.join(base, "chain", "db", "000002.sst"), "y".repeat(8192));
  fs.writeFileSync(path.join(base, "peer_id"), "peer");
  return base;
}

function mgr(dataRoot, onEvent = () => {}) {
  const manager = new NodeManager({
    templateRoot: path.join(__dirname, "..", "koinos-node-template"),
    dataRoot,
    onEvent,
  });
  // These tests exercise the atomic copy/verify/switch sequence, not Docker.
  // A seeded Compose file makes moveData stop the node first; isolate that
  // boundary so the suite also runs on hosts (including macOS CI) without a
  // Docker daemon or Compose CLI.
  manager.stop = async () => ({ stopped: true, note: "test double" });
  manager._settle = async () => {};
  return manager;
}

// ---------------------------------------------------------------- guardrails

test("a folder inside the current one is refused", () => {
  const src = tmp("src");
  seedChain(src);
  const r = dataMove.checkTarget(src, path.join(src, "deeper"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /inside the current data folder/i);
});

test("the current folder's own parent is refused", () => {
  const src = tmp("src");
  seedChain(src);
  // Moving into an ancestor is legal to copy but the cleanup step would then
  // delete the destination along with the source.
  const r = dataMove.checkTarget(path.join(src, "mainnet"), src);
  assert.equal(r.ok, false);
  assert.match(r.reason, /inside that one/i);
});

test("moving somewhere that already has files is refused", () => {
  const src = tmp("src");
  const dst = tmp("dst");
  seedChain(src);
  fs.writeFileSync(path.join(dst, "someone-elses-file.txt"), "hello");
  const r = dataMove.checkTarget(src, dst);
  assert.equal(r.ok, false);
  assert.match(r.reason, /already has something in it/i);
});

test("moving to the same place is refused rather than run pointlessly", () => {
  const src = tmp("src");
  seedChain(src);
  const r = dataMove.checkTarget(src, src);
  assert.equal(r.ok, false);
  assert.match(r.reason, /already where/i);
});

test("a target with too little room is refused, and says the numbers", () => {
  const src = tmp("src");
  const dst = path.join(tmp("dst"), "new");
  seedChain(src);
  // Headroom far beyond any disk: forces the branch deterministically without
  // needing a real full filesystem.
  const r = dataMove.checkTarget(src, dst, { headroomBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Not enough room/i);
  assert.ok(r.needBytes > 0, "it reports what the data actually weighs");
});

// ------------------------------------------------------------- the happy path

test("a completed move takes every file and leaves nothing behind", async () => {
  const src = tmp("src");
  const dstParent = tmp("dst");
  const dst = path.join(dstParent, "koinos");
  const base = seedChain(src);
  const before = dataMove.measure(src);

  const m = mgr(src);
  let switchedTo = null;
  const res = await m.moveData("mainnet", dst, { onSwitched: (d) => { switchedTo = d; } });

  assert.equal(res.moved, true);
  assert.equal(switchedTo, dst, "the setting is told the new home");
  assert.equal(m.dataRoot, dst, "and the manager itself is repointed");
  assert.equal(fs.existsSync(src), false, "the original is gone once the copy is proven");

  const after = dataMove.measure(dst);
  assert.equal(after.files, before.files, "same number of files");
  assert.equal(after.bytes, before.bytes, "same number of bytes");
  assert.equal(
    fs.readFileSync(path.join(dst, "mainnet", "basedir", "chain", "db", "000002.sst"), "utf8").length,
    8192,
    "a nested file arrived whole",
  );
  assert.ok(base, "seed produced a basedir");
});

test("no temp directory is left lying around afterwards", async () => {
  const src = tmp("src");
  const dstParent = tmp("dst");
  const dst = path.join(dstParent, "koinos");
  seedChain(src);
  await mgr(src).moveData("mainnet", dst);
  const leftovers = fs.readdirSync(dstParent).filter((n) => n.includes(dataMove.TEMP_SUFFIX));
  assert.deepEqual(leftovers, [], "the temp copy is swapped into place, not abandoned");
});

test("the moved node writes .env pointing at the NEW basedir", () => {
  /*
   * This is the one that would bite silently. BASEDIR in .env is an absolute
   * path handed to docker-compose; if it still named the old drive after a
   * move, Docker would mount a folder that no longer exists — or worse, an
   * empty one on a drive that does — and the node would look like it had lost
   * the chain. ensureFiles() regenerating from dataRoot is what prevents it,
   * and this pins that.
   */
  const src = tmp("src");
  const moved = tmp("moved");
  seedChain(src);
  const m = mgr(moved); // as if the move already happened
  m.ensureFiles("mainnet", null);
  const env = fs.readFileSync(path.join(moved, "mainnet", ".env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("BASEDIR="));
  assert.ok(line, ".env carries a BASEDIR");
  assert.equal(line, `BASEDIR=${path.join(moved, "mainnet", "basedir")}`);
  assert.ok(!env.includes(src), "no trace of the old location survives");
});

// --------------------------------------------------- failure leaves data alone

test("a move that fails verification deletes nothing", async () => {
  const src = tmp("src");
  const dstParent = tmp("dst");
  const dst = path.join(dstParent, "koinos");
  seedChain(src);
  const before = dataMove.measure(src);

  const m = mgr(src);
  // Corrupt the copy the instant it lands, before verification runs.
  const realVerify = dataMove.verifyTree;
  dataMove.verifyTree = () => ({ ok: false, checked: 3, missing: ["pretend/missing.sst"], wrongSize: [] });
  let err = null;
  try {
    await m.moveData("mainnet", dst);
  } catch (e) {
    err = e;
  } finally {
    dataMove.verifyTree = realVerify;
  }

  assert.ok(err, "the move fails loudly");
  assert.match(err.message, /did not match the original/i);
  assert.match(err.message, /Nothing was deleted/i);
  assert.equal(fs.existsSync(src), true, "the original is untouched");
  assert.deepEqual(dataMove.measure(src), before, "byte for byte, file for file");
  assert.equal(m.dataRoot, path.resolve(src), "and the node still points at it");
  assert.equal(fs.existsSync(dst), false, "the unverified copy is not left where it could be mistaken for good data");
});

test("a cancelled move deletes nothing and reports itself cancelled", async () => {
  const src = tmp("src");
  const dstParent = tmp("dst");
  const dst = path.join(dstParent, "koinos");
  seedChain(src);

  const m = mgr(src);
  // Cancel as soon as the copy starts.
  const realCopy = dataMove.copyTree;
  dataMove.copyTree = async () => {
    m.cancelMove();
    const e = new Error("cancelled");
    e.cancelled = true;
    throw e;
  };
  let res;
  try {
    res = await m.moveData("mainnet", dst);
  } finally {
    dataMove.copyTree = realCopy;
  }

  assert.equal(res.cancelled, true);
  assert.equal(fs.existsSync(src), true, "the original is untouched");
  assert.equal(m.dataRoot, path.resolve(src), "the node still points at it");
  assert.equal(m.moveStatus().phase, "cancelled");
  const leftovers = fs.readdirSync(dstParent).filter((n) => n.includes(dataMove.TEMP_SUFFIX));
  assert.deepEqual(leftovers, [], "the partial copy is cleaned up");
});

test("two moves cannot run at once", async () => {
  const src = tmp("src");
  const dst = path.join(tmp("dst"), "koinos");
  seedChain(src);
  const m = mgr(src);
  m._move = { running: true, phase: "copying" };
  await assert.rejects(() => m.moveData("mainnet", dst), /already running/i);
});

// ------------------------------------------------- checksums earn their cost

test("a file with the right SIZE but the wrong BYTES is caught", async () => {
  /*
   * This is the entire justification for the checksum pass. The size check
   * next door passes this case happily: every file is present and every
   * length matches. Only re-reading the content notices, and the reward for
   * noticing is that the original does NOT get deleted.
   */
  const src = tmp("src");
  const dstParent = tmp("dst");
  const dst = path.join(dstParent, "koinos");
  seedChain(src);
  const before = dataMove.measure(src);

  const m = mgr(src);
  // Corrupt the copy after it lands, keeping the length identical — exactly
  // what a bad cable or a failing sector looks like.
  const realCopy = dataMove.copyTree;
  dataMove.copyTree = async (a, b, opts) => {
    const out = await realCopy(a, b, opts);
    const victim = path.join(b, "mainnet", "basedir", "chain", "db", "000002.sst");
    const size = fs.statSync(victim).size;
    fs.writeFileSync(victim, "z".repeat(size));   // same size, different bytes
    return out;
  };

  let err = null;
  try {
    await m.moveData("mainnet", dst);
  } catch (e) {
    err = e;
  } finally {
    dataMove.copyTree = realCopy;
  }

  assert.ok(err, "the move fails");
  assert.match(err.message, /not identical to the original/i);
  assert.match(err.message, /000002\.sst/, "and names the file that differed");
  assert.match(err.message, /your data is untouched/i);
  assert.equal(fs.existsSync(src), true, "the original survives");
  assert.deepEqual(dataMove.measure(src), before);
  assert.equal(m.dataRoot, path.resolve(src), "and is still the configured one");
  assert.equal(fs.existsSync(dst), false, "the bad copy is not left in place");
});

test("the size check alone would NOT have caught it — which is why both run", () => {
  // Guards against someone later deciding the checksum pass is redundant.
  const a = tmp("a");
  const b = tmp("b");
  seedChain(a);
  fs.cpSync(a, b, { recursive: true });
  const victim = path.join(b, "mainnet", "basedir", "chain", "db", "000002.sst");
  fs.writeFileSync(victim, "z".repeat(fs.statSync(victim).size));

  assert.equal(dataMove.verifyTree(a, b).ok, true, "sizes all match, so the cheap check is happy");
});

test("checksums are taken from the source during the copy, not re-read afterwards", async () => {
  // Reading the source twice would double the cost of the slowest operation
  // in the app. copyTree returns the sums it computed on the way through.
  const src = tmp("src");
  const dst = path.join(tmp("dst"), "out");
  seedChain(src);
  const r = await dataMove.copyTree(src, dst, { total: 0 });
  assert.ok(r.sums instanceof Map, "the copy hands back what it hashed");
  assert.equal(r.sums.size, dataMove.measure(src).files, "one sha256 per file");
  const rel = path.join("mainnet", "basedir", "chain", "db", "000001.sst");
  const want = require("crypto").createHash("sha256")
    .update(fs.readFileSync(path.join(src, rel))).digest("hex");
  assert.equal(r.sums.get(rel), want, "and they are the real hashes");
});

test("checksumTree reports a mismatch precisely, and a clean copy as clean", async () => {
  const src = tmp("src");
  const dst = path.join(tmp("dst"), "out");
  seedChain(src);
  const { sums } = await dataMove.copyTree(src, dst, { total: 0 });

  const clean = await dataMove.checksumTree(dst, sums);
  assert.equal(clean.ok, true);
  assert.equal(clean.checked, sums.size);

  const victim = path.join(dst, "mainnet", "basedir", "peer_id");
  fs.writeFileSync(victim, "X".repeat(fs.statSync(victim).size));
  const dirty = await dataMove.checksumTree(dst, sums);
  assert.equal(dirty.ok, false);
  assert.equal(dirty.mismatched.length, 1);
  assert.equal(dirty.mismatched[0].path, path.join("mainnet", "basedir", "peer_id"));
});

// ------------------------------------------------------------------ reporting

test("progress is reported in bytes while the copy runs", async () => {
  const src = tmp("src");
  const dst = path.join(tmp("dst"), "koinos");
  seedChain(src);
  const seen = [];
  const m = mgr(src, (e) => { if (e.type === "node:move") seen.push(e.move.phase); });
  await m.moveData("mainnet", dst);
  // The phases a person watching the screen would expect to pass through.
  for (const phase of ["copying", "verifying", "checksumming", "switching", "done"]) {
    assert.ok(seen.includes(phase), `emitted the ${phase} phase (saw ${seen.join(",")})`);
  }
});

test("measure reports real sizes, so the UI can warn before it starts", () => {
  const src = tmp("src");
  seedChain(src);
  const { bytes, files } = dataMove.measure(src);
  assert.equal(files, 6);
  assert.ok(bytes >= 4096 + 8192, `counted the big files (${bytes})`);
});
