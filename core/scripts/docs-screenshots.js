"use strict";

/*
 * Screenshot generator for the tester docs (kai repo, public/docs/img/).
 *
 * Boots the REAL app headless (createCore + the fake llama engine, same
 * harness as the browser tests), drives the actual UI in Chromium, and
 * captures each view at a fixed viewport — authentic snapshots, not mockups.
 * Views that need network state (Network tab, live balances) are skipped:
 * an error-state screenshot teaches testers the wrong thing.
 *
 *   node core/scripts/docs-screenshots.js <output-dir>
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const OUT = process.argv[2];
if (!OUT) {
  console.error("usage: node core/scripts/docs-screenshots.js <output-dir>");
  process.exit(1);
}
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
const FAKE_BIN = path.join(__dirname, "..", "test", "fixtures", "fake-llama-server");

async function main() {
  const { chromium } = require("playwright-core");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-docshots-"));
  fs.mkdirSync(path.join(dir, "models"), { recursive: true });
  // Pre-place the pipeline model so onboarding is already done — the shots
  // should show the app as a set-up tester sees it.
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  fs.mkdirSync(OUT, { recursive: true });

  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: FAKE_BIN, onEvent: () => {} });
  const base = `http://127.0.0.1:${await core.start()}`;

  // A created wallet turns the Earn tab into the earn-ready panel with the
  // stats grid and the mainnet wallet card — the state the docs describe.
  await fetch(`${base}/core/earn/wallet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "docs screenshots 1" }),
  });

  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(base);
    await page.waitForSelector("#view-chat:not([hidden])");

    const shot = async (name, view, { readySel, scrollTo, fullPage = false } = {}) => {
      if (view) {
        await page.click(`.nav-item[data-view="${view}"]`);
        await page.waitForSelector(`#view-${view}:not([hidden])`);
      }
      if (readySel) await page.waitForSelector(readySel, { timeout: 15000 }).catch(() => {});
      if (scrollTo) await page.locator(scrollTo).first().scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(400); // let async paints settle
      await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
      console.log(`shot ${name}.png`);
    };

    await shot("chat", null); // already on chat
    await shot("models", "models", { readySel: "#models-list, #view-models" });
    await shot("earn", "earn", { readySel: "#earn-ready:not([hidden])" });
    await shot("earn-wallet", null, { scrollTo: "#wallet-address" });
    await shot("tools", "tools");
    await shot("api", "api");
    // Developer Tools (task #64): the switch reveals its own sidebar view —
    // capture each sub-menu. api-dev.png keeps its name (the docs reference
    // it) but now shows the Multi-agent builder.
    await page.click("#btn-dev-toggle");
    await page.waitForSelector("#nav-devtools:not([hidden])");
    await page.click("#nav-devtools");
    await page.waitForSelector("#view-devtools:not([hidden])");
    await page.waitForFunction(() => document.getElementById("ag-json").value.trim().length > 0);
    await shot("api-dev", null);
    await page.click('.subtab[data-tab="playground"]');
    await shot("devtools-playground", null);
    await page.click('.subtab[data-tab="pipelines"]');
    await shot("devtools-pipelines", null);
    await shot("tasks", "tasks");
    await shot("compare", "compare");
  } finally {
    await browser.close();
    await core.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
