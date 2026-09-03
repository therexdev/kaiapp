"use strict";

/*
 * The "QR Code" buttons on the node's Wallet and Fund screens, in a real
 * browser against the vendored node UI.
 *
 * qr.test.js pins the encoder. What it cannot see is the wiring, and the
 * wiring is where the money is lost: a button that opens a code for the WRONG
 * address — the KOIN one under the Ethereum heading, or a stale address left
 * over from before the wallet unlocked — is worse than no button at all,
 * because it looks authoritative and a phone will happily scan it.
 *
 * So the assertion that matters here is not "a QR appeared". It is that the
 * code in the modal decodes to exactly the address printed next to the button
 * that opened it. The check re-encodes the on-screen text and compares the
 * drawn paths, which is equivalent and needs no decoder in the test process.
 *
 * It also holds the vendoring line: all of this lives in bridge.js, so
 * renderer.js and styles.css stay byte-identical to the standalone app.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
const { UI_WAIT } = require("./ui-wait");

const available = (() => {
  try {
    require.resolve("playwright-core");
    fs.accessSync(CHROMIUM, fs.constants.X_OK);
    return true;
  } catch { return false; }
})();

const KOIN_ADDR = "1H7QvaYveeG4oBM7krKSpEMXwREv1RFjvK";
const ETH_ADDR = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

async function boot() {
  const { createCore } = require("../server");
  const core = await createCore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "kai-qr-")),
    port: 0,
    onEvent: () => {},
  });
  const port = await core.start();
  const base = `http://127.0.0.1:${port}`;
  // Local-Only makes the renderer replace the page with a privacy notice
  // instead of ever painting a wallet screen.
  await fetch(`${base}/core/network/config`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ privacyMode: "network" }),
  });
  return { core, base };
}

/*
 * Paint the two rows the buttons attach to.
 *
 * Standing up a real unlocked wallet and a funded Ethereum address inside a
 * test is not worth it, so the markup is built here — using the exact ids and
 * classes renderer.js uses. The last test in this file reads renderer.js and
 * asserts those anchors are still the ones it really builds, so this scaffold
 * cannot quietly drift away from the screens it stands in for.
 */
const paintAnchors = (page, koin, eth) => page.evaluate(([koinAddr, ethAddr]) => {
  const wallet = document.getElementById("view-wallet");
  wallet.innerHTML =
    '<div class="card"><div class="row">' +
    '<div class="addr" style="flex:1">' + koinAddr + "</div>" +
    '<button id="w-copy" class="btn">Copy</button>' +
    "</div></div>" +
    '<div class="card"><div class="row" style="gap:8px;align-items:center">' +
    '<div class="addr" id="w-eth-addr" style="flex:1">' + ethAddr + "</div>" +
    '<button id="w-eth-copy" class="btn">Copy</button>' +
    "</div></div>";
  const fund = document.getElementById("view-fund");
  fund.innerHTML =
    '<div class="card"><div id="fund-addr-wrap">' +
    '<div class="mono">' + ethAddr + "</div>" +
    '<div class="row"><button id="fund-copy" class="btn">Copy address</button></div>' +
    "</div></div>";
}, [koin, eth]);

/** Click a QR button and read back what the modal actually shows. */
const openQr = (page, buttonId) => page.evaluate((id) => {
  document.getElementById(id).click();
  const modal = document.querySelector("#modal-root .modal");
  if (!modal) return null;
  const svg = modal.querySelector("svg");
  return {
    title: modal.querySelector("h2").textContent,
    address: (modal.querySelector(".addr") || {}).textContent || "",
    warning: (modal.querySelector(".banner.warn") || {}).textContent || "",
    // The drawn path is the code itself; comparing it to a fresh encode of the
    // address on screen is the same claim as decoding it.
    path: svg ? svg.querySelector("path").getAttribute("d") : null,
    actions: Array.from(modal.querySelectorAll(".actions .btn")).map((b) => b.textContent),
  };
}, buttonId);

const closeModal = (page) => page.evaluate(() => {
  const el = document.querySelector("#modal-root .modal-backdrop");
  if (el) el.remove();
});

async function openUi(page, base) {
  await page.goto(`${base}/knode/index.html`);
  await page.waitForFunction(() => !!window.KQR, { timeout: UI_WAIT });
  await paintAnchors(page, KOIN_ADDR, ETH_ADDR);
  await page.waitForFunction(() => !!document.getElementById("kai-qr-fund"), { timeout: UI_WAIT });
}

test("every address gets a QR button, and each shows its own address",
  { skip: !available, timeout: 120000 }, async (t) => {
    const { core, base } = await boot();
    const { chromium } = require("playwright-core");
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    t.after(async () => { await browser.close(); await core.stop?.(); });

    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await openUi(page, base);

    // The button sits beside Copy, which is where someone looking for it will
    // look — not at the bottom of the card.
    const placement = await page.evaluate(() =>
      ["w-copy", "w-eth-copy", "fund-copy"].map((id) => {
        const next = document.getElementById(id).nextElementSibling;
        return next ? next.id + "|" + next.textContent : null;
      })
    );
    assert.deepStrictEqual(placement, [
      "kai-qr-koin|QR Code",
      "kai-qr-eth|QR Code",
      "kai-qr-fund|QR Code",
    ], "each QR button should sit immediately after its Copy button");

    const koin = await openQr(page, "kai-qr-koin");
    assert.equal(koin.address, KOIN_ADDR, "the Koinos sheet shows the Koinos address");
    assert.match(koin.warning, /Koinos address/i, "and says which chain it is");
    assert.deepStrictEqual(koin.actions, ["Copy address", "Done"]);
    await closeModal(page);

    const eth = await openQr(page, "kai-qr-eth");
    assert.equal(eth.address, ETH_ADDR, "the Ethereum sheet shows the Ethereum address");
    assert.match(eth.warning, /Ethereum Mainnet/i, "and carries the network caveat with it");
    await closeModal(page);

    const fund = await openQr(page, "kai-qr-fund");
    assert.equal(fund.address, ETH_ADDR, "the Fund sheet shows the funding address");
    assert.match(fund.warning, /Ethereum Mainnet/i);
    await closeModal(page);

    // The whole point: the two chains must not be showing the same code.
    assert.notEqual(koin.path, eth.path, "the Koinos and Ethereum codes must differ");

    // And each code is the code for the address printed beside it.
    const expected = await page.evaluate(([a, b]) => ({
      koin: window.KQR.svg(window.KQR.encode(a, { ec: "M" }), { scale: 6, quiet: 4 }),
      eth: window.KQR.svg(window.KQR.encode(b, { ec: "M" }), { scale: 6, quiet: 4 }),
    }), [KOIN_ADDR, ETH_ADDR]);
    assert.ok(expected.koin.includes(koin.path), "the Koinos code encodes the address on screen");
    assert.ok(expected.eth.includes(eth.path), "the Ethereum code encodes the address on screen");
    assert.ok(expected.eth.includes(fund.path), "the Fund code encodes the address on screen");
  });

test("a repainted screen keeps its buttons, and a placeholder gets no code",
  { skip: !available, timeout: 120000 }, async (t) => {
    const { core, base } = await boot();
    const { chromium } = require("playwright-core");
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    t.after(async () => { await browser.close(); await core.stop?.(); });

    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await openUi(page, base);

    // renderer.js rebuilds whole views from innerHTML — on unlock, and on
    // every fund refresh. Buttons added once would vanish on the first
    // repaint and the feature would look broken at random.
    await paintAnchors(page, KOIN_ADDR, ETH_ADDR);
    await page.waitForFunction(() => !!document.getElementById("kai-qr-koin"), { timeout: UI_WAIT });
    const again = await openQr(page, "kai-qr-koin");
    assert.equal(again.address, KOIN_ADDR, "the button still works after a repaint");
    await closeModal(page);

    // Exactly one, not one per repaint.
    const count = await page.evaluate(() => document.querySelectorAll("#kai-qr-koin, .btn.ghost").length &&
      Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "QR Code").length);
    assert.equal(count, 3, "repainting must not stack duplicate buttons");

    // Before the wallet unlocks the renderer prints "(unavailable)" — offering
    // to encode that would produce a confident, scannable, meaningless code.
    await page.evaluate(() => { document.getElementById("w-eth-addr").textContent = "(unavailable)"; });
    const none = await openQr(page, "kai-qr-eth");
    assert.equal(none, null, "no sheet should open for a placeholder address");
  });

test("it is all in bridge.js, so the vendored files stay pristine",
  { skip: !available, timeout: 60000 }, async () => {
    const dir = path.join(__dirname, "..", "..", "ui", "knode");
    for (const f of ["renderer.js", "styles.css"]) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      assert.equal(/kai-qr|QR Code|KQR/.test(text), false,
        `${f} must contain nothing about this feature — it re-vendors from the standalone app`);
    }
    const bridge = fs.readFileSync(path.join(dir, "bridge.js"), "utf8");
    assert.match(bridge, /kai-qr-koin/, "it all lives in bridge.js");

    // The anchors this feature attaches to are really the ones renderer.js
    // builds, so the scaffold in this file cannot drift from the real screens.
    const renderer = fs.readFileSync(path.join(dir, "renderer.js"), "utf8");
    for (const id of ["w-copy", "w-eth-copy", "fund-copy", "w-eth-addr", "fund-addr-wrap"]) {
      assert.ok(renderer.includes(`"${id}"`) || renderer.includes(`id="${id}"`),
        `renderer.js still builds #${id}, which the QR buttons attach to`);
    }
  });
