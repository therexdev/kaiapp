#!/usr/bin/env node
"use strict";

/*
 * Drives the Koinos panel in a real browser against a real Core.
 *
 * Unit tests pin the service; this proves the parts only a browser can break:
 * that the toggle actually reveals the nav item and the view, that the panel
 * paints from live Core responses, that the capability verdict reaches the
 * screen, and — the one that matters most — that a machine which cannot run a
 * node is told so plainly instead of being offered a button.
 *
 *   node core/scripts/verify-koinos-ui.js
 *
 * No Docker, no network to Koinos, no funds. The chain client is stubbed at
 * the service boundary so the run is deterministic.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const { Gateway } = require("../lib/gateway");
const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");
const { ApiKeys } = require("../lib/keys");
const { KoinosService } = require("../lib/koinos");

const CHROME = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures += 1;
};

async function boot(hardware, privacyMode = "network") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-koinos-ui-"));
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const koinos = new KoinosService({ settings, hardware, dataDir: dir, onEvent: () => {} });

  // Stub the chain at the service boundary: deterministic, and this script
  // must never depend on api.koinos.io being reachable from CI.
  koinos.balances = async (address) => {
    if (!/^1[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(address)) throw new Error("That is not a valid Koinos address");
    return { address, koin: "12.5", vhp: "3.25", mana: "12.5", sats: {} };
  };
  koinos.nodeProbe = async () => ({ url: "http://127.0.0.1:8080", connected: true, height: 9876543, behind: 0, synced: true });

  const gw = new Gateway({
    host: "127.0.0.1",
    port: 0,
    models: new ModelManager({ catalogPath: path.join(__dirname, "..", "models", "catalog.json"), modelsDir: path.join(dir, "m"), state: new JsonStore(path.join(dir, "st.json"), {}), onEvent: () => {} }),
    keys: new ApiKeys(new JsonStore(path.join(dir, "k.json"), {})),
    runtime: { status: () => ({ running: false }) },
    coreInfo: () => ({ version: "test" }),
    // Without this the gateway fails CLOSED to local-only — correct, but it
    // would mean this script never exercised the normal case.
    network: { status: () => ({ privacyMode }) },
    uiDir: path.join(__dirname, "..", "..", "ui"),
    koinos,
    onEvent: () => {},
  });
  await gw.listen();
  return { gw, base: `http://127.0.0.1:${gw.port}` };
}

async function run(label, hardware, fn, privacyMode) {
  const { gw, base } = await boot(hardware, privacyMode);
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(700);
  // The toggle lives at the bottom of Earn, and the app opens on Chat, so
  // every case starts by going where a user would go.
  await page.locator('.nav-item[data-view="earn"]').click();
  await page.waitForTimeout(400);
  console.log(`\n--- ${label} ---`);
  ok("the page loads with no script errors", errors.length === 0, errors[0] || "");
  try {
    await fn(page);
  } finally {
    await browser.close();
    await gw.close();
  }
}

(async () => {
  // 1. An ordinary desktop that CAN run a node.
  await run("x64 desktop, 32 GB RAM, 200 GB free", { platform: "linux", arch: "x64", ramBytes: 32 * 1024 ** 3, diskFreeBytes: 200 * 1024 ** 3 }, async (page) => {
    ok("the Koinos nav item is hidden until asked for", await page.locator("#nav-koinos").isHidden());
    ok("the toggle sits at the bottom of Earn", (await page.locator("#btn-koinos-toggle").count()) === 1);
    ok("the toggle reads 'Turn on'", (await page.locator("#btn-koinos-toggle").textContent()).trim() === "Turn on");

    await page.locator("#btn-koinos-toggle").click();
    await page.waitForTimeout(500);
    ok("flipping it reveals the nav item", await page.locator("#nav-koinos").isVisible());
    ok("…and the toggle now offers to turn it off", (await page.locator("#btn-koinos-toggle").textContent()).trim() === "Turn off");

    await page.locator("#nav-koinos").click();
    await page.waitForTimeout(600);
    ok("the Koinos view opens", await page.locator("#view-koinos").isVisible());
    const tag = (await page.locator("#koinos-net-tag").textContent()).trim();
    ok("a standing mainnet tag sits in the heading", /mainnet/i.test(tag), tag);

    const verdict = (await page.locator("#koinos-cap-verdict").textContent()).trim();
    ok("it says this computer CAN run a node", /can run/i.test(verdict), verdict);
    ok("and offers a way to get the node app", await page.locator("#btn-koinos-get").isVisible());

    const node = (await page.locator("#koinos-node-state").textContent()).trim();
    ok("the node card reports the connection", /Connected/i.test(node), node);

    await page.locator("#koinos-watch").fill("1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E");
    await page.locator("#btn-koinos-watch").click();
    await page.waitForTimeout(500);
    ok("balances paint for a looked-up address", (await page.locator("#koinos-koin").textContent()).trim() === "12.5");
    ok("VHP too", (await page.locator("#koinos-vhp").textContent()).trim() === "3.25");
    ok("mana is shown and explained", (await page.locator("#koinos-mana-hint").textContent()).includes("five days"));

    await page.locator("#koinos-watch").fill("1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3X");
    await page.locator("#btn-koinos-watch").click();
    await page.waitForTimeout(500);
    ok("a mistyped address is refused, not silently accepted", await page.locator("#koinos-watch-error").isVisible());

    // Turning it off must not strand the user on a view that just vanished.
    await page.locator('.nav-item[data-view="earn"]').click();
    await page.waitForTimeout(300);
    await page.locator("#btn-koinos-toggle").click();
    await page.waitForTimeout(500);
    ok("turning it off hides the nav item again", await page.locator("#nav-koinos").isHidden());
  });

  // 2. The Raspberry Pi — the case the design cares most about getting honest.
  await run("arm64 Raspberry Pi, 8 GB RAM", { platform: "linux", arch: "arm64", ramBytes: 8 * 1024 ** 3, diskFreeBytes: 200 * 1024 ** 3 }, async (page) => {
    await page.locator("#btn-koinos-toggle").click();
    await page.waitForTimeout(400);
    await page.locator("#nav-koinos").click();
    await page.waitForTimeout(600);

    const verdict = (await page.locator("#koinos-cap-verdict").textContent()).trim();
    const detail = (await page.locator("#koinos-cap-detail").textContent()).trim();
    ok("it says plainly that this computer can't run one", /can't run/i.test(verdict), verdict);
    ok("…and blames the CHIP, not the speed", /doesn't exist for this chip/i.test(detail));
    ok("no install button is offered on a machine that cannot use it", await page.locator("#btn-koinos-get").isHidden());
    ok("no open button either", await page.locator("#btn-koinos-open").isHidden());
    ok("it still points at what DOES work here", /watch a node running somewhere else/i.test(detail));

    // The Pi is a first-class dashboard: everything else still functions.
    await page.locator("#koinos-watch").fill("1K1AUovu5NjjPcaTxmde6wPB8Y8PQGFV3E");
    await page.locator("#btn-koinos-watch").click();
    await page.waitForTimeout(500);
    ok("balances work fine on the Pi", (await page.locator("#koinos-koin").textContent()).trim() === "12.5");
  });

  // 3. Local-Only. The sidebar promises nothing leaves this machine, so the
  //    chain cards must go quiet and SAY why — not offer buttons that 403.
  await run("x64 desktop, Privacy = Local-Only", { platform: "linux", arch: "x64", ramBytes: 32 * 1024 ** 3, diskFreeBytes: 200 * 1024 ** 3 }, async (page) => {
    await page.locator("#btn-koinos-toggle").click();
    await page.waitForTimeout(400);
    await page.locator("#nav-koinos").click();
    await page.waitForTimeout(600);

    ok("the address box is disabled", await page.locator("#koinos-watch").isDisabled());
    ok("…and so is its button", await page.locator("#btn-koinos-watch").isDisabled());
    ok("the node field is disabled too", await page.locator("#koinos-rpc").isDisabled());
    const hint = (await page.locator("#koinos-watch-hint").textContent()).trim();
    ok("it names Local-Only as the reason", /Local-Only/.test(hint), hint);
    ok("…and says how to change it", /Settings/.test(hint));
    const node = (await page.locator("#koinos-node-state").textContent()).trim();
    ok("the node card says the same", /Local-Only/.test(node), node);

    // The local half still works: hardware truth needs no network.
    const verdict = (await page.locator("#koinos-cap-verdict").textContent()).trim();
    ok("the hardware verdict still works — it needs no network", /can run/i.test(verdict), verdict);
  }, "local-only");

  console.log(failures ? `\nKOINOS UI CHECK FAILED (${failures})` : "\nKOINOS UI CHECK PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
