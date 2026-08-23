"use strict";

/*
 * The Node value card, rendered in a real browser against the vendored node UI.
 *
 * The arithmetic is pinned in koin-price.test.js. What this pins is the part
 * that arithmetic cannot: that an unknown reaches the screen as an unknown.
 * Every figure here is money, and the failure that matters is not a wrong
 * number — it is a confident one. "$0.00 per day" on a node that has simply
 * never produced is a false statement about someone's hardware.
 *
 * It also holds the vendoring line: this card is built entirely from
 * bridge.js, so renderer.js and styles.css stay byte-identical to the
 * standalone app and re-vendor cleanly.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
const UI_WAIT = 30000;
const SATS = 100000000;

const available = (() => {
  try {
    require.resolve("playwright-core");
    fs.accessSync(CHROMIUM, fs.constants.X_OK);
    return true;
  } catch { return false; }
})();

/*
 * Open the vendored node UI and make sure the two anchors the card attaches to
 * exist. #view-dashboard is in the shipped index.html; #d-tiles is created by
 * renderer.js when it paints the dashboard, which needs a live node behind it.
 * Rather than stand a whole node up, the tile grid is created here — and the
 * last test in this file asserts against the real renderer that this is still
 * the shape it builds, so this scaffold cannot quietly drift away from it.
 */
async function openNodeUi(page, base) {
  await page.goto(`${base}/knode/index.html`);
  await page.waitForFunction(() => !!window.KaiNodeValue, { timeout: UI_WAIT });
  await page.evaluate(() => {
    const root = document.getElementById("view-dashboard");
    if (root && !document.getElementById("d-tiles")) {
      const g = document.createElement("div");
      g.className = "widget-grid";
      g.id = "d-tiles";
      root.appendChild(g);
    }
  });
  await page.waitForFunction(() => !!document.getElementById("d-tiles"), { timeout: UI_WAIT });
}

/*
 * Paint and read in ONE evaluate.
 *
 * Reading separately is racy, and finding that out was worth the trouble: the
 * dashboard's own poll calls dashboard:summary every few seconds, bridge.js
 * repaints this card from the response, and with no real node behind the test
 * that response carries empty values. Two separate steps let that poll land in
 * between and blank the tiles. Atomic here — and the race itself is evidence
 * the production wiring does what it claims.
 */
const paintAndRead = (page, payload) => page.evaluate((d) => {
  window.KaiNodeValue.paint(d);
  const cell = (id) => {
    const t = document.getElementById(id);
    return t ? { label: t.childNodes[0].textContent, value: t.childNodes[1].textContent, sub: t.childNodes[2].textContent } : null;
  };
  return {
    total: cell("kai-v-total"), daily: cell("kai-v-daily"),
    weekly: cell("kai-v-weekly"), yearly: cell("kai-v-yearly"),
    note: (document.getElementById("kai-value-note") || {}).textContent || "",
  };
}, payload);

async function boot() {
  const { createCore } = require("../server");
  const core = await createCore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "kai-nval-")), port: 0, onEvent: () => {} });
  const port = await core.start();
  const base = `http://127.0.0.1:${port}`;
  /*
   * The node reads the Koinos chain, and a fresh Core defaults to Local-Only,
   * which refuses that egress — the vendored renderer then replaces the whole
   * page with a privacy notice and never builds a dashboard at all. Worth
   * knowing: this is what a real tester sees if they open the node screen
   * before changing the privacy mode.
   */
  await fetch(`${base}/core/network/config`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ privacyMode: "network" }),
  });
  return { core, base };
}

test("a producing node shows what it holds and what it earns", { skip: !available, timeout: 120000 }, async (t) => {
  const { core, base } = await boot();
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  t.after(async () => { await browser.close(); await core.stop?.(); });

  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await openNodeUi(page, base);

  const r = await paintAndRead(page, {
    value: {
      nodeValueUsd: 512, dailyUsd: 1.25, weeklyUsd: 8.75, yearlyUsd: 456.25,
      daysTracked: 21, basis: "measured", usdPerKoin: 0.05,
    },
    price: { usdPerKoin: 0.05, ageMs: 1000, stale: false, error: null },
  });

  assert.match(r.total.value, /^\$512/, "node value in dollars");
  assert.match(r.total.sub, /KOIN \+ VHP/, "and says what it counted");
  assert.match(r.daily.value, /^\$1\.25/);
  assert.match(r.weekly.value, /^\$8\.75/);
  assert.match(r.yearly.value, /^\$456/);
  assert.match(r.daily.sub, /21 days measured/);
  assert.match(r.weekly.label, /^Est\. weekly$/,
    "labels stay on one line, so the four values align across the row");
  assert.match(r.note, /Uniswap/, "names where the price came from");
  assert.match(r.note, /not a forecast/i, "and does not let a projection read as a promise");
});

test("a node with no history says so instead of claiming it earns nothing",
  { skip: !available, timeout: 120000 }, async (t) => {
    const { core, base } = await boot();
    const { chromium } = require("playwright-core");
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    t.after(async () => { await browser.close(); await core.stop?.(); });

    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await openNodeUi(page, base);

    const r = await paintAndRead(page, {
      value: {
        nodeValueUsd: 25, dailyUsd: null, weeklyUsd: null, yearlyUsd: null,
        daysTracked: 0, basis: "no-history", usdPerKoin: 0.05,
      },
      price: { usdPerKoin: 0.05, ageMs: 0, stale: false, error: null },
    });

    for (const key of ["daily", "weekly", "yearly"]) {
      assert.equal(r[key].value, "—", `${key} must not read as a dollar amount`);
      assert.doesNotMatch(r[key].value, /\$0/, "and above all must not read as $0.00");
      assert.match(r[key].sub, /not enough history/i);
    }
    assert.match(r.total.value, /^\$25/,
      "what it holds is known even when what it earns is not");
  });

test("no price means no dollar figures, with the reason on the card",
  { skip: !available, timeout: 120000 }, async (t) => {
    const { core, base } = await boot();
    const { chromium } = require("playwright-core");
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    t.after(async () => { await browser.close(); await core.stop?.(); });

    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await openNodeUi(page, base);

    const r = await paintAndRead(page, {
      value: { nodeValueUsd: null, dailyUsd: null, weeklyUsd: null, yearlyUsd: null, daysTracked: 9, basis: "measured", usdPerKoin: null },
      price: { usdPerKoin: null, ageMs: null, stale: false, error: "No Ethereum RPC reachable" },
    });

    assert.equal(r.total.value, "—");
    assert.match(r.total.sub, /waiting for a price/i);
    assert.match(r.note, /No Ethereum RPC reachable/,
      "an offline machine is told why, not left with a blank box");
  });

test("a price that could not be refreshed is marked old rather than passed off as current",
  { skip: !available, timeout: 120000 }, async (t) => {
    const { core, base } = await boot();
    const { chromium } = require("playwright-core");
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    t.after(async () => { await browser.close(); await core.stop?.(); });

    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await openNodeUi(page, base);

    const r = await paintAndRead(page, {
      value: { nodeValueUsd: 100, dailyUsd: 1, weeklyUsd: 7, yearlyUsd: 365, daysTracked: 5, basis: "measured", usdPerKoin: 0.05 },
      price: { usdPerKoin: 0.05, ageMs: 3 * 3600 * 1000, stale: true, error: "No Ethereum RPC reachable" },
    });
    assert.match(r.note, /price \d+ min old/i, "a three-hour-old price must say so");
  });

test("the card is built without touching the vendored renderer or stylesheet",
  { skip: !available, timeout: 60000 }, async () => {
    // The whole reason difference #4 lives in bridge.js: these two files are
    // byte-for-byte the standalone app's, so it re-vendors cleanly.
    const dir = path.join(__dirname, "..", "..", "ui", "knode");
    for (const f of ["renderer.js", "styles.css"]) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      assert.equal(/kai-value|kai-v-|KaiNodeValue/.test(text), false,
        `${f} must contain nothing about this feature`);
    }
    const bridge = fs.readFileSync(path.join(dir, "bridge.js"), "utf8");
    assert.match(bridge, /kai-value-card/, "it all lives in bridge.js");

    // And the anchors the card attaches to are really the ones those files
    // provide — so the scaffold above stays honest if the vendored app moves.
    assert.match(fs.readFileSync(path.join(dir, "renderer.js"), "utf8"), /id="d-tiles"/,
      "renderer.js still builds the tile grid this card inserts itself after");
    assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /id="view-dashboard"/,
      "and the dashboard section it lives in is still in the markup");
  });
