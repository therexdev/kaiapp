"use strict";

/*
 * Every relative require in the shipped source must resolve.
 *
 * A tester hit "Cannot find module './lib/usdt-send'" by typing a number into
 * the USDT funding box. The path was wrong — from core/lib/koinos-node.js it
 * pointed at core/lib/lib/usdt-send, which has never existed — and every
 * sibling three lines away was already using the correct ./koinos/ prefix.
 *
 * What made it survive to a release is that it was a LAZY require, sitting
 * inside a handler. Node resolves a require when it runs, so a bad path in a
 * rarely-taken branch is invisible at startup, invisible to a smoke test, and
 * invisible to every test that does not happen to walk that exact code path.
 * It waits, silently, for whoever tries the feature first.
 *
 * A static scan does not care whether the line ever runs. This walks the files
 * electron-builder actually packages and resolves every relative specifier in
 * them, so the next one of these fails in CI rather than in someone's hands.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..", "..");

// The `files` globs in package.json's build config, minus the tests that are
// explicitly excluded from the package.
const SHIPPED = ["core", "electron", "cli", "ui"];
const SKIP_DIRS = new Set(["node_modules", "test", "fixtures", ".git", "dist"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith(".js")) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// Only string literals. A computed specifier cannot be checked statically, and
// pretending otherwise would mean either false failures or a quietly weakened
// test — they are counted and reported instead.
const RELATIVE_REQUIRE = /require\(\s*(["'])(\.[^"']*)\1\s*\)/g;

test("every relative require in the packaged source resolves", () => {
  const files = SHIPPED.flatMap((d) => walk(path.join(ROOT, d)));
  assert.ok(files.length > 50, `expected to find the source tree, found ${files.length} files`);

  const broken = [];
  let checked = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const req = Module.createRequire(file);
    for (const m of src.matchAll(RELATIVE_REQUIRE)) {
      const spec = m[2];
      checked += 1;
      try {
        req.resolve(spec);
      } catch {
        // Report where it is, so the failure names the line to fix rather than
        // sending someone hunting through a thousand files.
        const line = src.slice(0, m.index).split("\n").length;
        broken.push(`${path.relative(ROOT, file)}:${line} → ${spec}`);
      }
    }
  }

  assert.ok(checked > 100, `expected to check a real number of requires, checked ${checked}`);
  assert.deepEqual(
    broken, [],
    `these requires point at files that do not exist:\n  ${broken.join("\n  ")}`,
  );
});

test("dynamic requires are reported, so the gap in this check stays visible", () => {
  // Not a failure — a specifier built from a variable cannot be resolved
  // statically. Knowing how many there are is the point: if this number grows
  // a lot, the scan above is covering proportionally less of the tree.
  const files = SHIPPED.flatMap((d) => walk(path.join(ROOT, d)));
  const dynamic = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/require\(\s*(?!["'])[^)]{1,80}\)/g)) {
      dynamic.push(`${path.relative(ROOT, file)} → ${m[0].slice(0, 60)}`);
    }
  }
  assert.ok(dynamic.length < 40, `unexpectedly many computed requires (${dynamic.length}):\n  ${dynamic.slice(0, 10).join("\n  ")}`);
});

/* ---------------------------------------------------------------------------
 * The exact channel that broke, driven end to end.
 *
 * The static scan above proves the path resolves. This proves the handler
 * actually runs it: it reaches the amount check without a network connection,
 * which is only true because parsing now happens before the provider is
 * built. On the shipped code this threw MODULE_NOT_FOUND instead.
 * ------------------------------------------------------------------------ */
const os = require("os");

test("fund:usdtFundQuote validates the amount without a module error", async () => {
  const { buildChannels } = require("../lib/koinos-node");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-usdtq-"));

  // Only the pieces this one handler touches; everything else can be inert.
  const channels = buildChannels({
    settings: { get: (_k, d) => d, set: () => {}, all: () => ({}) },
    state: { get: () => null, set: () => {} },
    wallet: { ethAddress: "0x000000000000000000000000000000000000dEaD", status: () => ({ unlocked: true }) },
    chain: { network: () => ({ id: "mainnet" }), provider: () => null },
    nodeMgr: {}, setup: {}, rewards: { status: () => ({ config: {} }) }, stats: {},
    bridge: {}, routeC: {}, userData: dir, appVersion: "test", defaultNodeData: dir,
  });

  const fn = channels.get("fund:usdtFundQuote");
  assert.ok(fn, "the channel exists");

  await assert.rejects(
    () => fn({ amountUsdt: "0" }),
    (e) => {
      // The failure that shipped: resolution, not validation.
      assert.notEqual(e.code, "MODULE_NOT_FOUND", `still a module error: ${e.message}`);
      assert.doesNotMatch(String(e.message), /Cannot find module/i);
      assert.match(String(e.message), /greater than 0/i, `expected the amount check, got: ${e.message}`);
      return true;
    },
  );
});
