#!/usr/bin/env node
/*
 * Correctness harness for ui/knode/qr.js.
 *
 * A QR code that is subtly wrong still LOOKS like a QR code, so eyeballing the
 * square proves nothing. The failure we care about is a tester's phone
 * refusing to scan, or — far worse — scanning a corrupted address and sending
 * KOIN into a hole. So this checks two independent things:
 *
 *   1. DECODE. Render each matrix to a bitmap and read it back with zxing-cpp,
 *      an independent decoder of the same lineage phone scanners use. The
 *      decoded text must equal the input byte for byte. This is the property
 *      that actually matters, and nothing about our own encoder is trusted in
 *      making the judgement.
 *
 *   2. STRUCTURE. Compare the module matrix cell by cell against Python's
 *      `qrcode` package. A decode can survive a handful of wrong modules
 *      because Reed-Solomon repairs them — a code can be "scannable" while
 *      quietly eating its whole error-correction budget, which then fails on a
 *      scuffed screen or a bad angle. Exact equality proves we are not
 *      spending that budget.
 *
 *      One deliberate exception: the mask is compared at the REFERENCE's own
 *      choice rather than ours. Mask selection is a scoring tie-break, and
 *      python-qrcode scores its candidates with the format-information area
 *      blanked while ISO/IEC 18004 scores it filled in. Both yield valid
 *      symbols; they just disagree on which is prettiest. Everything that
 *      determines what the code MEANS — bit stream, error correction,
 *      interleaving, module placement, format bits — is compared exactly.
 *
 * Reference deps live outside the app:  pip install qrcode zxing-cpp pillow
 * Missing deps SKIP with exit 2 (never a silent pass).
 */
"use strict";
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const KQR = require(path.join(__dirname, "..", "ui", "knode", "qr.js"));

const PY_REF = `
import json, sys
import qrcode
from qrcode.util import QRData, MODE_8BIT_BYTE
from qrcode.constants import ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q, ERROR_CORRECT_H
LV = {"L": ERROR_CORRECT_L, "M": ERROR_CORRECT_M, "Q": ERROR_CORRECT_Q, "H": ERROR_CORRECT_H}
out = []
for text, ec in json.load(sys.stdin):
    q = qrcode.QRCode(error_correction=LV[ec], box_size=1, border=0)
    # Force byte mode: left to itself the reference picks numeric/alphanumeric
    # for suitable strings, which our encoder never does, and then the two are
    # not encoding the same thing at all.
    q.add_data(QRData(text.encode(), mode=MODE_8BIT_BYTE))
    q.make(fit=True)
    out.append({"version": q.version, "matrix": [[1 if c else 0 for c in row] for row in q.modules]})
print(json.dumps(out))
`;

const PY_DECODE = `
import json, sys
from PIL import Image
import zxingcpp
results = []
for item in json.load(sys.stdin):
    m = item["matrix"]
    n = len(m)
    quiet, scale = 4, 4          # quiet zone + upscale, as a scanner would see
    side = (n + quiet * 2) * scale
    img = Image.new("L", (side, side), 255)
    px = img.load()
    for i in range(n):
        for j in range(n):
            if m[i][j]:
                for dy in range(scale):
                    for dx in range(scale):
                        px[(j + quiet) * scale + dx, (i + quiet) * scale + dy] = 0
    got = zxingcpp.read_barcode(img)
    results.append({
        "text": got.text if got else None,
        "format": str(got.format) if got else None,
        "ec": item["ec"],
    })
print(json.dumps(results))
`;

function py(script, payload) {
  return JSON.parse(
    execFileSync("python3", ["-c", script], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    })
  );
}

// The reference's chosen mask, read out of its format-information modules.
const FORMAT_POS = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
                    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
function maskOf(matrix) {
  let v = 0;
  for (const [r, c] of FORMAT_POS) v = (v << 1) | matrix[r][c];
  return ((v ^ 0x5412) >> 10) & 7;
}

// ---- cases: the real payloads first, then every version/level boundary ----
const KOIN_ADDR = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK";
const ETH_ADDR = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

const cases = [
  [KOIN_ADDR, "M"], [ETH_ADDR, "M"], [KOIN_ADDR, "L"], [ETH_ADDR, "Q"], [ETH_ADDR, "H"],
  ["a", "M"], ["0x0", "H"], ["1234567890", "M"], ["ALLCAPS-123", "Q"],
];

const LEVELS = ["L", "M", "Q", "H"];
const CAP = {
  L: [17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
  M: [14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
  Q: [11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
  H: [7, 14, 24, 34, 44, 58, 64, 84, 98, 119],
};
for (const ec of LEVELS) {
  for (let v = 1; v <= KQR.MAX_VERSION; v++) {
    const cap = CAP[ec][v - 1];
    for (const len of [cap - 1, cap]) {
      if (len < 1) continue;
      let s = "";
      for (let i = 0; i < len; i++) s += "0123456789abcdefXYZ-_.:/"[(i * 7 + len) % 24];
      cases.push([s, ec]);
    }
  }
}

let refs;
try {
  refs = py(PY_REF, cases);
} catch (e) {
  const msg = String(e.stderr || e.message || e);
  if (/ModuleNotFoundError|No module named/.test(msg)) {
    console.error("SKIP: reference deps missing. Install with:  pip install qrcode zxing-cpp pillow");
    process.exit(2);
  }
  throw e;
}

const failures = [];
const mine = [];
const seen = new Set();

cases.forEach(([text, ec], idx) => {
  const ref = refs[idx];
  seen.add(`${ref.version}${ec}`);

  // Our own automatic encode — this is what the app will actually render.
  let auto;
  try {
    auto = KQR.encode(text, { ec });
  } catch (e) {
    failures.push(`len=${text.length} ec=${ec}: encoder threw: ${e.message}`);
    return;
  }
  mine.push({ matrix: auto, text, ec, version: ref.version });

  if (auto.length !== ref.matrix.length) {
    failures.push(
      `len=${text.length} ec=${ec}: size ${auto.length} != reference ${ref.matrix.length} (ref v${ref.version})`
    );
    return;
  }

  // Structural comparison at the reference's mask, so a legitimate difference
  // in mask *preference* cannot mask a real difference in everything else.
  const pinned = KQR.encode(text, { ec, mask: maskOf(ref.matrix) });
  const diffs = [];
  for (let i = 0; i < pinned.length; i++) {
    for (let j = 0; j < pinned.length; j++) {
      if (pinned[i][j] !== ref.matrix[i][j]) diffs.push(`(${i},${j})`);
    }
  }
  if (diffs.length) {
    failures.push(
      `len=${text.length} ec=${ec} v${ref.version}: ${diffs.length} module(s) differ from reference at mask ${maskOf(ref.matrix)}, first ${diffs.slice(0, 6).join(" ")}`
    );
  }
});

// ---- decode every matrix we actually produce ----
let decoded;
try {
  decoded = py(PY_DECODE, mine.map((m) => ({ matrix: m.matrix, ec: m.ec })));
} catch (e) {
  const msg = String(e.stderr || e.message || e);
  if (/ModuleNotFoundError|No module named/.test(msg)) {
    console.error("SKIP: decoder missing. Install with:  pip install zxing-cpp pillow");
    process.exit(2);
  }
  throw e;
}

decoded.forEach((got, i) => {
  const want = mine[i];
  if (got.text == null) {
    failures.push(`len=${want.text.length} ec=${want.ec} v${want.version}: DECODER COULD NOT READ our own code`);
  } else if (got.text !== want.text) {
    failures.push(
      `len=${want.text.length} ec=${want.ec} v${want.version}: decoded text differs — got ${JSON.stringify(got.text.slice(0, 40))} want ${JSON.stringify(want.text.slice(0, 40))}`
    );
  }
});

const expected = LEVELS.length * KQR.MAX_VERSION;
if (seen.size < expected) {
  failures.push(`coverage: exercised ${seen.size} of ${expected} version/level combinations`);
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log(
  `qr-verify: ${mine.length} codes — all decoded back to their exact input by zxing-cpp, ` +
    `and all module-identical to the reference encoder across ${expected} version/level combinations.`
);
