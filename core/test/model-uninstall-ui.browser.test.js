"use strict";

/*
 * Uninstalling a model from the Models screen, in a real Chromium against a
 * real Core.
 *
 * The unit tests prove the removal is correct and the gateway tests prove the
 * route is. Neither proves the button exists, is wired, and is NOT offered for
 * the model currently loaded — and "the button does nothing in the packaged
 * app" is a bug this repo has shipped twice.
 *
 * It also pins the thing most likely to be got wrong later: an IMPORTED model
 * offers "remove from the list", a DOWNLOADED one offers "remove from disk",
 * and the two must never swap labels.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
const FAKE_BIN = path.join(__dirname, "fixtures", "fake-llama-server");

// One bound for every in-page wait — same reasoning as the other browser
// suites: these are "has the UI got there yet", not performance budgets, and
// `node --test` runs files alongside each other.
const { UI_WAIT } = require("./ui-wait");

const available = (() => {
  try {
    require.resolve("playwright-core");
    fs.accessSync(CHROMIUM, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
})();

/** Core with two catalog models already "downloaded", plus the UI. */
async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rmui-"));
  const catalogPath = path.join(dir, "catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({
    aliases: {
      "keeper": { label: "Keeper Model", package: "keep@1", minRamGb: 1 },
      "goner": { label: "Goner Model", package: "gone@1", minRamGb: 1 },
    },
    packages: {
      "keep@1": { filename: "keep.gguf", url: "http://127.0.0.1:1/x", sha256: "1".repeat(64), sizeBytes: 4096, runtime: "llamacpp" },
      "gone@1": { filename: "gone.gguf", url: "http://127.0.0.1:1/y", sha256: "2".repeat(64), sizeBytes: 4096, runtime: "llamacpp" },
    },
  }));

  const modelsDir = path.join(dir, "models");
  fs.mkdirSync(modelsDir, { recursive: true });
  fs.writeFileSync(path.join(modelsDir, "keep.gguf"), "k".repeat(4096));
  fs.writeFileSync(path.join(modelsDir, "gone.gguf"), "g".repeat(4096));

  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const { ModelManager } = require("../lib/model-manager");
  const { JsonStore } = require("../lib/store");
  const swapped = new ModelManager({
    catalogPath, modelsDir,
    state: new JsonStore(path.join(dir, "state.json"), {}),
    onEvent: () => {},
  });
  core.models.catalog = swapped.catalog;
  core.models.modelsDir = swapped.modelsDir;
  core.runtime.models = core.models;
  core.gateway.models = core.models;

  const port = await core.start();
  return { dir, modelsDir, core, base: `http://127.0.0.1:${port}` };
}

/** Open the app straight on Models, past onboarding. */
async function openModels(page, base) {
  await page.goto(base);
  // Onboarding only shows with no model present; here two are, so the app
  // lands on chat. Navigate the way a person would.
  await page.waitForSelector("#view-chat:not([hidden]), #view-onboarding:not([hidden])", { timeout: UI_WAIT });
  await page.evaluate(() => document.querySelector('[data-view="models"]')?.click());
  await page.waitForSelector("#view-models:not([hidden])", { timeout: UI_WAIT });
  await page.waitForFunction(
    () => document.querySelectorAll("#models-list .model-row").length > 0,
    { timeout: UI_WAIT },
  );
}

test("a downloaded model can be removed from the Models screen", { skip: !available, timeout: 120000 }, async (t) => {
  const { modelsDir, core, base } = await boot();
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  t.after(async () => { await browser.close(); await core.stop?.(); });

  const page = await browser.newPage();
  const asked = [];
  page.on("dialog", (d) => { asked.push(d.message()); d.accept(); });

  await openModels(page, base);

  const btn = await page.$('[data-uninstall="gone@1"]');
  assert.ok(btn, "installed models offer a remove control");

  await btn.click();
  await page.waitForFunction(
    () => !document.querySelector('[data-uninstall="gone@1"]'),
    { timeout: UI_WAIT },
  );

  assert.equal(fs.existsSync(path.join(modelsDir, "gone.gguf")), false, "the weights are gone from disk");
  assert.equal(fs.existsSync(path.join(modelsDir, "keep.gguf")), true, "and only the one asked for");

  // The confirm must say what it frees and that it is reversible — this is a
  // destructive action and the copy is the only thing standing in front of it.
  assert.equal(asked.length, 1, "exactly one confirmation, not a silent delete");
  assert.match(asked[0], /Goner Model/);
  assert.match(asked[0], /frees/i);
  assert.match(asked[0], /download it again/i);
});

test("the loaded model offers no remove button at all", { skip: !available, timeout: 120000 }, async (t) => {
  const { modelsDir, core, base } = await boot();
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  t.after(async () => { await browser.close(); await core.stop?.(); });

  await core.runtime.ensure("keeper");           // keeper is now live
  const page = await browser.newPage();
  page.on("dialog", (d) => d.accept());
  await openModels(page, base);

  await page.waitForFunction(
    () => [...document.querySelectorAll(".model-row")].some((r) => r.textContent.includes("in use")),
    { timeout: UI_WAIT },
  );

  const enabled = await page.$('[data-uninstall="keep@1"]');
  assert.equal(enabled, null, "no live remove control for the model being served");
  const disabled = await page.evaluate(() =>
    [...document.querySelectorAll(".model-row")]
      .find((r) => r.textContent.includes("in use"))
      ?.querySelector("button[disabled]")?.title || null);
  assert.match(disabled || "", /switch to another/i, "and it says why, rather than just vanishing");

  assert.equal(fs.existsSync(path.join(modelsDir, "keep.gguf")), true);
  core.runtime.stop();
});

test("an imported model's control still promises not to delete the user's file",
  { skip: !available, timeout: 120000 }, async (t) => {
    const { dir, core, base } = await boot();
    const { chromium } = require("playwright-core");
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    t.after(async () => { await browser.close(); await core.stop?.(); });

    // A model of the user's own, imported in place.
    const mine = path.join(dir, "MyOwn.gguf");
    fs.writeFileSync(mine, crypto.randomBytes(2048));
    await core.models.importCustom({ path: mine });

    const page = await browser.newPage();
    page.on("dialog", (d) => d.accept());
    await openModels(page, base);

    const title = await page.evaluate(() =>
      document.querySelector("[data-remove-custom]")?.title || null);
    assert.ok(title, "imported models keep their own control");
    assert.match(title, /your file is not deleted/i,
      "and it is the one that promises the file survives — never the disk-deleting one");

    // The two controls must not be confused for each other.
    const isAlsoUninstall = await page.evaluate(() =>
      !!document.querySelector("[data-remove-custom][data-uninstall]"));
    assert.equal(isAlsoUninstall, false, "an imported model never gets the delete-from-disk control");
  });

/*
 * The bug this file did not catch the first time.
 *
 * Every assertion above passed while the control was, to a person, not there
 * at all: it borrowed `.chat-del`, which is `opacity: 0` until you hover the
 * row of a CHAT list, and a model card is not one. Playwright does not treat
 * `opacity: 0` as hidden — a fully transparent element still has a box, still
 * takes clicks, still answers `$()` — so a DOM-shaped test says yes to a
 * feature nobody can find.
 *
 * The second half is the layout. `.model-offer` is a `space-between` flex row
 * built for two children; a remove button dropped in as a third sibling turns
 * the middle slot into a parking space, and "Use" drifts to a spot that moves
 * with the length of each model's blurb. So: assert what the eye checks —
 * the control is visible, and the buttons line up down the right edge.
 */
test("the remove control is actually visible, and the buttons stay right-aligned",
  { skip: !available, timeout: 120000 }, async (t) => {
    const { core, base } = await boot();
    const { chromium } = require("playwright-core");
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    t.after(async () => { await browser.close(); await core.stop?.(); });

    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    page.on("dialog", (d) => d.dismiss());
    await openModels(page, base);

    // Visible WITHOUT hovering anything: read it cold, mouse parked far away.
    await page.mouse.move(0, 0);
    const del = await page.evaluate(() => {
      const b = document.querySelector('[data-uninstall="gone@1"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return {
        opacity: Number(getComputedStyle(b).opacity),
        visibility: getComputedStyle(b).visibility,
        w: r.width, h: r.height,
        inActions: !!b.closest(".model-actions"),
      };
    });
    assert.ok(del, "the remove control is in the DOM");
    assert.ok(del.opacity > 0.25,
      `it is visible without hovering (opacity ${del.opacity})`);
    assert.equal(del.visibility, "visible");
    assert.ok(del.w > 8 && del.h > 8, `and big enough to aim at (${del.w}×${del.h})`);
    assert.ok(del.inActions, "and it sits with the row's other actions");

    // Right-aligned: every card's action group ends at the card's inner edge,
    // and no card has grown a third top-level slot for space-between to fill.
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll("#models-list .model-row")].map((row) => {
        const acts = row.querySelector(".model-actions");
        return {
          children: row.children.length,
          gap: acts ? row.getBoundingClientRect().right - acts.getBoundingClientRect().right : null,
          text: row.querySelector(".model-name")?.textContent || "",
        };
      }));
    assert.ok(rows.length >= 2, "there are cards to check");
    for (const r of rows) {
      assert.equal(r.children, 2, `“${r.text}” is a two-slot row, not three`);
      assert.ok(r.gap != null && r.gap < 30,
        `“${r.text}” keeps its buttons on the right edge (${Math.round(r.gap)}px in)`);
    }
  });
