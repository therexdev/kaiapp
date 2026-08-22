"use strict";

/*
 * The chain-data-folder UI, in a real Chromium, against the real Core channels.
 *
 * The static tests next door prove the MOVE is safe. This proves the parts a
 * person actually touches are wired to it: that the button exists on the Node
 * screen at all, that picking a bad folder is refused with a sentence rather
 * than silence, and — the one that matters most — that confirming a move
 * really moves the bytes and repoints the node.
 *
 * It exists because "the button does nothing in the packaged app" has shipped
 * from this repo twice. A static grep catches prompt(); nothing but a browser
 * catches a listener that was never attached.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

// Same reasoning as code-ui.browser.test.js: one bound for every in-page wait,
// generous enough to survive `node --test` running files alongside this one.
const UI_WAIT = 30000;

const { chromium } = require("playwright-core");
const { NodeManager } = require("../lib/koinos/node-manager");
const dataMove = require("../lib/koinos/data-move");

function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kai-ddui-${label}-`));
}

function seedChain(root) {
  const base = path.join(root, "mainnet", "basedir", "chain");
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(path.join(root, "mainnet", "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "mainnet", "docker-compose.yml"), "services: {}\n");
  fs.writeFileSync(path.join(root, "mainnet", "config", "config.yml"), "chain: {}\n");
  fs.writeFileSync(path.join(base, "000001.sst"), "x".repeat(2048));
  fs.writeFileSync(path.join(base, "000002.sst"), "y".repeat(1024));
}

/**
 * A page carrying the real bridge.js, the DOM it expects, and a stub `rpc`
 * that dispatches straight into the real Core channel handlers over the
 * NodeManager under test. The vendored renderer is not involved — this is
 * about the bridge's own additions, and loading a whole node app to click one
 * button would test Chromium more than it tests us.
 */
async function pageWith(mgrState) {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const page = await browser.newPage();

  // The Core side, live, in this process.
  const handlers = {
    "node:dataDir": () => {
      const current = path.resolve(mgrState.mgr.dataRoot);
      const size = dataMove.measure(current);
      return {
        path: current,
        defaultPath: mgrState.defaultPath,
        isDefault: path.resolve(mgrState.defaultPath) === current,
        sizeBytes: size.bytes,
        fileCount: size.files,
        freeBytes: dataMove.freeBytes(current),
        hasData: size.files > 0,
        move: mgrState.mgr.moveStatus(),
      };
    },
    "node:inspectDataDir": ({ path: t }) => mgrState.mgr.inspectMove(String(t)),
    "node:setDataDir": ({ path: t }) => {
      const next = path.resolve(String(t));
      const check = dataMove.checkTarget(path.resolve(mgrState.mgr.dataRoot), next);
      if (!check.ok) throw new Error(check.reason);
      fs.mkdirSync(next, { recursive: true });
      mgrState.mgr.dataRoot = next;
      mgrState.persisted = next;
      return { path: next, changed: true };
    },
    "node:moveDataDir": ({ path: t }) =>
      mgrState.mgr.moveData("mainnet", String(t), { onSwitched: (d) => { mgrState.persisted = d; } }),
    "node:moveDataDirStatus": () => mgrState.mgr.moveStatus(),
    "node:moveDataDirCancel": () => mgrState.mgr.cancelMove(),
  };

  // bridge.js talks to Core over fetch(/core/koinos/rpc); route it to the
  // in-process handlers so the test drives the SAME code the app does.
  /*
   * The page needs a REAL origin. setContent() leaves it on about:blank,
   * where bridge.js's relative fetch("/core/koinos/rpc") has nothing to
   * resolve against and fails before any modal can open — which looked
   * exactly like a dead button, the very bug this file exists to catch.
   */
  await page.route("http://knode.test/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><html><body>
        <div id="modal-root"></div>
        <div id="toasts"></div>
        <div id="view-node"><div class="row"><button id="n-open">Data folder</button></div></div>
      </body></html>`,
    });
  });

  /*
   * Dispatch entirely in Node. An earlier version fulfilled the route by
   * calling back INTO the page, which deadlocks: the route handler waits on
   * page.evaluate while the page waits on the fetch that triggered the route.
   */
  await page.route("**/core/koinos/rpc", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    let res;
    try {
      const fn = handlers[body.channel];
      res = fn
        ? { ok: true, data: await fn(body.payload || {}) }
        : { ok: false, error: `no such channel ${body.channel}` };
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(res) });
  });

  await page.goto("http://knode.test/");
  await page.addScriptTag({ path: path.join(__dirname, "..", "..", "ui", "knode", "bridge.js") });
  return { browser, page };
}

test("the Node screen gains a Change data folder button next to the vendored one", async (t) => {
  const src = tmp("src");
  seedChain(src);
  const state = { mgr: new NodeManager({ templateRoot: "/none", dataRoot: src, onEvent: () => {} }), defaultPath: src };
  const { browser, page } = await pageWith(state);
  t.after(() => browser.close());

  await page.waitForSelector("#kai-n-move", { timeout: UI_WAIT });
  const [openText, moveText] = await page.evaluate(() => [
    document.getElementById("n-open").textContent,
    document.getElementById("kai-n-move").textContent,
  ]);
  assert.match(openText, /Data folder/, "the vendored button is untouched");
  assert.match(moveText, /Change data folder/);

  // Attaching must be idempotent — it runs on a timer against a view that
  // re-renders, and two buttons would be worse than none.
  await page.evaluate(() => { window.KaiNodeData.attach(); window.KaiNodeData.attach(); });
  const count = await page.evaluate(() => document.querySelectorAll("#kai-n-move").length);
  assert.equal(count, 1, "one button, however many times the view repaints");
});

test("a folder inside the current one is refused in the UI, with the reason shown", async (t) => {
  const src = tmp("src");
  seedChain(src);
  const state = { mgr: new NodeManager({ templateRoot: "/none", dataRoot: src, onEvent: () => {} }), defaultPath: src };
  const { browser, page } = await pageWith(state);
  t.after(() => browser.close());

  await page.waitForSelector("#kai-n-move", { timeout: UI_WAIT });
  await page.click("#kai-n-move");
  await page.waitForSelector("#kai-dd-input", { timeout: UI_WAIT });

  await page.fill("#kai-dd-input", path.join(src, "inside"));
  await page.click("#kai-dd-change");
  await page.waitForFunction(
    () => {
      const w = document.getElementById("kai-dd-warn");
      return w && w.style.display !== "none" && w.textContent.length > 0;
    },
    { timeout: UI_WAIT },
  );
  const warn = await page.textContent("#kai-dd-warn");
  assert.match(warn, /inside the current data folder/i);
  const disabled = await page.evaluate(() => document.getElementById("kai-dd-confirm").disabled);
  assert.equal(disabled, true, "and the confirm button will not let it through");
});

test("confirming a move actually moves the bytes and repoints the node", async (t) => {
  const src = tmp("src");
  const dstParent = tmp("dst");
  const dst = path.join(dstParent, "koinos-data");
  seedChain(src);
  const before = dataMove.measure(src);

  const state = { mgr: new NodeManager({ templateRoot: "/none", dataRoot: src, onEvent: () => {} }), defaultPath: src, persisted: null };
  const { browser, page } = await pageWith(state);
  t.after(() => browser.close());

  await page.waitForSelector("#kai-n-move", { timeout: UI_WAIT });
  await page.click("#kai-n-move");
  await page.waitForSelector("#kai-dd-input", { timeout: UI_WAIT });

  // The modal must be the MOVE one, since there is data here — not the
  // cheap "just change the setting" one.
  const heading = await page.textContent(".modal h2");
  assert.match(heading, /Move the chain data/i);

  await page.fill("#kai-dd-input", dst);
  await page.click("#kai-dd-change");
  await page.waitForFunction(
    () => document.getElementById("kai-dd-confirm") && !document.getElementById("kai-dd-confirm").disabled,
    { timeout: UI_WAIT },
  );
  await page.click("#kai-dd-confirm");

  // Progress modal, then completion.
  await page.waitForSelector("#kai-move-phase", { timeout: UI_WAIT });
  await page.waitForFunction(
    () => !document.getElementById("kai-move-phase"),
    { timeout: UI_WAIT },
  );

  assert.equal(state.mgr.moveStatus().phase, "done", "the move reports itself finished");
  assert.equal(state.persisted, dst, "the new location was persisted");
  assert.equal(fs.existsSync(src), false, "the original is gone, once proven");
  const after = dataMove.measure(dst);
  assert.equal(after.files, before.files, "every file arrived");
  assert.equal(after.bytes, before.bytes, "every byte arrived");
});

test("with no data yet, changing the folder is a setting and says so", async (t) => {
  const src = tmp("empty");          // nothing seeded: nothing to move
  const dst = path.join(tmp("dst"), "elsewhere");
  const state = { mgr: new NodeManager({ templateRoot: "/none", dataRoot: src, onEvent: () => {} }), defaultPath: src, persisted: null };
  const { browser, page } = await pageWith(state);
  t.after(() => browser.close());

  await page.waitForSelector("#kai-n-move", { timeout: UI_WAIT });
  await page.click("#kai-n-move");
  await page.waitForSelector("#kai-dd-input", { timeout: UI_WAIT });

  const heading = await page.textContent(".modal h2");
  assert.match(heading, /Where should the chain data go/i, "not the move wording, because there is nothing to move");

  await page.fill("#kai-dd-input", dst);
  await page.click("#kai-dd-change");
  await page.waitForFunction(
    () => document.getElementById("kai-dd-confirm") && !document.getElementById("kai-dd-confirm").disabled,
    { timeout: UI_WAIT },
  );
  await page.click("#kai-dd-confirm");
  await page.waitForFunction(() => !document.getElementById("kai-dd-confirm"), { timeout: UI_WAIT });

  assert.equal(state.persisted, dst, "the choice was saved");
  assert.equal(path.resolve(state.mgr.dataRoot), dst, "and the node points at it");
  assert.equal(state.mgr.moveStatus(), null, "no move was run — there was nothing to move");
});

test("the setup flow offers the folder before quick sync, with the default filled in", async (t) => {
  const src = tmp("empty");
  const state = { mgr: new NodeManager({ templateRoot: "/none", dataRoot: src, onEvent: () => {} }), defaultPath: src, persisted: null };
  const { browser, page } = await pageWith(state);
  t.after(() => browser.close());

  // What quick sync triggers, without needing the vendored renderer.
  const asked = page.evaluate(() => window.KaiNodeData.askBeforeQuickSync());
  await page.waitForSelector("#kai-dd-path", { timeout: UI_WAIT });

  const shown = await page.textContent("#kai-dd-path");
  assert.equal(shown, path.resolve(src), "the default location is already filled in — a default, not a blank");
  const lead = await page.textContent(".modal-body p");
  assert.match(lead, /tens of gigabytes/i, "and it says why this is worth a moment's thought");

  // Backing out must not block the sync.
  await page.click("#kai-dd-cancel");
  await asked;
  assert.equal(state.persisted, null, "cancelling changes nothing");
});
