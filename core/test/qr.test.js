"use strict";

/*
 * The QR encoder behind the "QR Code" buttons on the node's Wallet and Fund
 * screens.
 *
 * What this file can and cannot do is worth being precise about, because the
 * failure that matters here is financial: a code that scans into a corrupted
 * address sends someone's KOIN into a hole.
 *
 * Real correctness — "does a scanner read this back as the address we put in"
 * — is settled in scripts/qr-verify.js, which encodes every version and error
 * level, decodes each one with zxing-cpp, and separately compares every module
 * against Python's `qrcode`. That needs pip packages, so it is a developer
 * gate rather than part of this suite.
 *
 * What lives here is the part that must fail on an ordinary `npm test`: the
 * golden matrices below were captured from the encoder ONLY once that harness
 * had verified it, so any future edit that changes a single module in a real
 * address's code turns this red. That is deliberately a tripwire and not a
 * proof — if it fires, the answer is to run qr-verify and find out which of
 * the two is wrong, not to re-capture the fixture.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");

// The encoder is a browser script that also exports for require().
const KQR = require(path.join(__dirname, "..", "..", "ui", "knode", "qr.js"));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "qr-golden.json"), "utf8"));

const KOIN_ADDR = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK";
const ETH_ADDR = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

test("the codes for real addresses are byte-for-byte what was verified", () => {
  assert.ok(GOLDEN.length >= 4, "fixture should cover both address shapes");
  for (const g of GOLDEN) {
    const rows = KQR.encode(g.text, { ec: g.ec }).map((r) => r.join(""));
    assert.deepStrictEqual(
      rows,
      g.rows,
      `${g.text.slice(0, 12)}… at level ${g.ec} no longer encodes the way scripts/qr-verify.js verified it`
    );
  }
});

test("both address shapes fit comfortably, and the size is stable", () => {
  // A Koinos address and an Ethereum address both land in version 3 at level
  // M (29x29). Pinned because a version bump would mean the capacity tables
  // moved, and the module count is what decides whether it stays readable in
  // a small modal.
  assert.equal(KQR.encode(KOIN_ADDR, { ec: "M" }).length, 29);
  assert.equal(KQR.encode(ETH_ADDR, { ec: "M" }).length, 29);
});

test("stronger error correction costs modules, which is the trade being made", () => {
  const m = KQR.encode(ETH_ADDR, { ec: "M" }).length;
  const h = KQR.encode(ETH_ADDR, { ec: "H" }).length;
  assert.ok(h > m, `level H should need a bigger symbol than M, got ${h} vs ${m}`);
});

test("every matrix is square, binary, and carries the three finder patterns", () => {
  const m = KQR.encode(KOIN_ADDR, { ec: "M" });
  const n = m.length;
  for (const row of m) {
    assert.equal(row.length, n, "not square");
    for (const v of row) assert.ok(v === 0 || v === 1, `module is ${v}, expected 0 or 1`);
  }
  // A finder is a 7x7 ring with a 3x3 core. Checking all three corners catches
  // an orientation mistake, which is the kind of bug that still LOOKS like a
  // QR code to a human reading the screen.
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.equal(m[r0][c0], 1, `finder at ${r0},${c0} missing its outer ring`);
    assert.equal(m[r0 + 1][c0 + 1], 0, "finder ring should be one module of light inside");
    assert.equal(m[r0 + 3][c0 + 3], 1, "finder core should be dark");
  }
});

test("it refuses rather than truncates when asked for too much", () => {
  // Silently dropping characters would produce a scannable code for the WRONG
  // address, which is the worst outcome available here.
  const tooLong = "x".repeat(400);
  assert.throws(() => KQR.encode(tooLong, { ec: "M" }), /too long/i);
  assert.throws(() => KQR.encode("", { ec: "M" }), /nothing to encode/i);
  assert.throws(() => KQR.encode(KOIN_ADDR, { ec: "Z" }), /error-correction/i);
});

test("the SVG draws the matrix it was given, with a quiet zone", () => {
  const m = KQR.encode(KOIN_ADDR, { ec: "M" });
  const svg = KQR.svg(m, { scale: 6, quiet: 4 });
  const side = (m.length + 8) * 6;
  assert.match(svg, new RegExp(`width="${side}"`), "quiet zone must be included in the drawn size");
  // Dark-on-light regardless of the app's theme: scanners need the polarity,
  // and every surface around this modal is dark.
  assert.match(svg, /<rect[^>]+fill="#ffffff"/, "needs its own white ground");
  assert.match(svg, /fill="#000000"/, "modules must be dark");

  const dark = m.flat().filter(Boolean).length;
  const drawn = (svg.match(/M\d+ \d+h6v6h-6z/g) || []).length;
  assert.equal(drawn, dark, "every dark module, and only those, should be drawn");
});
