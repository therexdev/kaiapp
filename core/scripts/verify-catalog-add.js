#!/usr/bin/env node
"use strict";

/* Drives the Tools view in a real browser: the "Your files" catalog add must
 * actually add (field report: prompt() is a no-op in Electron so Add did
 * nothing), and an installed entry must leave the dropdown. */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright-core");

const { Gateway } = require("../lib/gateway");
const { ModelManager } = require("../lib/model-manager");
const { JsonStore } = require("../lib/store");
const { ApiKeys } = require("../lib/keys");
const { McpManager } = require("../lib/mcp-manager");
const { ToolRegistry } = require("../lib/tools");

const CHROME = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
let failures = 0;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures += 1;
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mcp-ui-"));
  const settings = new JsonStore(path.join(dir, "settings.json"), {});
  const registry = new ToolRegistry({ onEvent: () => {} });
  const mcp = new McpManager({ settings, registry, onEvent: () => {} });
  // The UI's post-add connect would download the real npm package — out of
  // scope for a UI check. Adding and listing use the real manager.
  mcp.connect = async () => ({ ok: true, tools: [] });

  const gw = new Gateway({
    host: "127.0.0.1",
    port: 0,
    models: new ModelManager({ catalogPath: path.join(__dirname, "..", "models", "catalog.json"), modelsDir: path.join(dir, "m"), state: new JsonStore(path.join(dir, "st.json"), {}), onEvent: () => {} }),
    keys: new ApiKeys(new JsonStore(path.join(dir, "k.json"), {})),
    runtime: { status: () => ({ running: false }) },
    coreInfo: () => ({ version: "test" }),
    network: { status: () => ({ privacyMode: "network" }) },
    uiDir: path.join(__dirname, "..", "..", "ui"),
    mcp,
    nodeRuntime: { status: () => ({ available: true, source: "system", version: "v22" }) },
    onEvent: () => {},
  });
  await gw.listen();

  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  page.on("dialog", (d) => d.accept());
  await page.goto(`http://127.0.0.1:${gw.port}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.locator('.nav-item[data-view="tools"]').click();
  await page.waitForTimeout(800);

  const optsBefore = await page.locator("#mcp-catalog option").allTextContents();
  ok("the catalog lists Your files before install", optsBefore.some((t) => t.includes("Your files")), String(optsBefore.length));

  // The field flow: pick "Your files", click Add. No Electron here, so the
  // inline fallback appears; a folder path goes in; Add again.
  await page.locator("#mcp-catalog").selectOption("filesystem");
  await page.locator("#mcp-add-catalog").click();
  await page.waitForTimeout(400);
  ok("first click reveals the folder box instead of doing nothing", await page.locator("#mcp-catalog-arg").isVisible());

  await page.locator("#mcp-catalog-arg").fill(dir);
  await page.locator("#mcp-add-catalog").click();
  await page.waitForTimeout(900);

  const servers = mcp.servers();
  const fsrv = servers.find((s) => s.name === "Your files (folders you pick)");
  ok("the server was actually added", Boolean(fsrv), JSON.stringify(servers.map((s) => s.name)));
  ok("…with the chosen folder as its final argument", fsrv && fsrv.args[fsrv.args.length - 1] === dir, String(fsrv?.args?.slice(-1)));

  await page.waitForTimeout(1200); // let the panel re-render
  const optsAfter = await page.locator("#mcp-catalog option").allTextContents();
  ok("the installed entry left the dropdown", !optsAfter.some((t) => t.includes("Your files")), JSON.stringify(optsAfter.map((t) => t.slice(0, 24))));
  ok("the other catalog entries remain", optsAfter.length === 3, String(optsAfter.length));
  ok("no uncaught page errors", errors.length === 0, errors[0] || "");

  await browser.close();
  await gw.close();
  console.log(failures ? `\nCATALOG ADD CHECK FAILED (${failures})` : "\nCATALOG ADD CHECK PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
