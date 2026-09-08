"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";
const shot = async (page, name, options = {}) => {
  if (!process.env.KAI_MASCOT_QA_DIR) return;
  fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, "brand-" + name + ".png"), animations: "disabled", ...options });
};

// Real Core and real UI, fake local weights/runtime. No owner profile, external
// providers, live balances or node processes are involved in these screenshots.
test("KAI workspace: artwork, welcome drafts, all navigation and narrow-window history", { skip: !fs.existsSync(CHROMIUM), timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-brand-ui-"));
  fs.mkdirSync(path.join(dir, "models"));
  fs.writeFileSync(path.join(dir, "models", "smollm2-135m-instruct-q8_0.gguf"), "weights");
  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, llamaBin: path.join(__dirname, "fixtures/fake-llama-server"), onEvent: () => {} });
  const base = "http://127.0.0.1:" + await core.start();
  const { chromium } = require("playwright-core");
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  const errors = [], failedArt = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (/kai-character\.png|kai-robot\.svg|brand-mark\.svg/.test(response.url()) && !response.ok()) failedArt.push(response.url()); });
  await page.addInitScript(() => {
    window.__mascotLaunches = [];
    window.koinosShell = { launchMascot: async options => window.__mascotLaunches.push(options), onMascotOpenView() {},
      minimize() {}, toggleMaximize() {}, close() {}, onMaximizeChanged() {} };
  });
  await page.goto(base);
  await page.waitForSelector('#view-chat:not([hidden]) [data-kai-mounted="ready"] svg');
  const texture = await page.evaluate(() => new Promise(resolve => {
    const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null); image.src = "assets/kai-character.png";
  }));
  assert.deepEqual(texture, { width: 1024, height: 1536 }, "The real Core serves the bundled texture");
  await shot(page, "chat-home");
  await page.click('[data-chat-prompt*="turn an idea"]');
  assert.match(await page.inputValue("#input"), /turn an idea/);
  assert.equal(await page.locator(".msg.user").count(), 0, "Welcome cards create editable drafts, not automatic requests");
  await page.click("#launch-kai");
  assert.equal((await page.evaluate(() => window.__mascotLaunches)).length, 1);
  await page.fill("#input", "Hello from the new workspace."); await page.click("#btn-send");
  await page.waitForFunction(() => document.querySelector(".msg.assistant")?.textContent.includes("Hello from fake llama") && document.getElementById("btn-stop").hidden);
  await shot(page, "chat-reply");
  await page.click("#nav-settings");
  for (const id of ["btn-dev-toggle", "btn-code-toggle"]) {
    if (await page.getAttribute("#" + id, "aria-checked") !== "true") await page.click("#" + id);
  }
  for (const view of ["models", "docs", "compare", "tools", "tasks", "api", "earn", "network", "settings", "code", "devtools"]) {
    await page.click(`[data-view="${view}"]`);
    await page.waitForSelector(`#view-${view}:not([hidden])`);
    await shot(page, view);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${view} fits the window`);
  }
  // Mock only the node service boundary; the embedded renderer/bridge/styles
  // are real. No route can fall through and start Docker or reach a chain.
  const info = await core.gateway.koinosNode.call("app:info");
  const fixture = {
    "app:info": info, "wallet:status": { exists: false, unlocked: false },
    "dashboard:summary": { network: info.networks.mainnet, wallet: { exists: false },
      node: { docker: { ok: true }, isRunning: true, runningCount: 7 },
      sync: { inSync: true, local: { height: 38297044 }, remote: { height: 38297044 }, progressPct: 100 },
      balances: { koin: "4308560000", vhp: "228813610000", mana: "3822790000" },
      stats: { available: true, totals: null, feed: [], windows: { last24h: "3120000", last7d: "21650000", last30d: "93480000", daysTracked: 30 } },
      returns: { yearlyProfitSats: "1137340000", yearlyReturnPct: .497 } },
  };
  await page.route("**/core/koinos/rpc", route => {
    const { channel } = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(
      Object.hasOwn(fixture, channel) ? { ok: true, data: fixture[channel] } : { ok: false, error: "Unavailable in visual fixture" }) });
  });
  await page.route("**/core/koinos", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true, chainReadsAllowed: true }) }));
  await page.click("#nav-settings");
  await page.waitForSelector("#nav-koinos:not([hidden])"); await page.click("#nav-koinos");
  const frame = page.frameLocator("#koinos-frame");
  await frame.locator("#d-status-text").filter({ hasText: "Running" }).waitFor();
  await shot(page, "node-dashboard");
  await page.click('[data-knode="koinos-wallet"]');
  await frame.locator("#view-wallet.active").waitFor(); await shot(page, "wallet");
  await page.click('[data-view="chat"]'); await page.setViewportSize({ width: 820, height: 700 });
  await page.click("#history-toggle");
  assert.equal(await page.locator("#chats-pane").isVisible(), true);
  await page.click("#btn-new-chat");
  assert.equal(await page.locator("#chats-pane").isVisible(), false);
  await page.waitForSelector('#chat-empty [data-kai-mounted="ready"]');
  await page.click('[data-chat-prompt*="brainstorm"]'); assert.match(await page.inputValue("#input"), /brainstorm/);
  const bounds = await page.evaluate(() => {
    const pane = document.querySelector(".chat-pane").getBoundingClientRect(), composer = document.getElementById("composer").getBoundingClientRect();
    return { fits: composer.left >= pane.left && composer.right <= pane.right && composer.bottom <= innerHeight,
      unique: document.querySelectorAll("svg [id]").length === new Set([...document.querySelectorAll("svg [id]")].map(e => e.id)).size };
  });
  assert.ok(bounds.fits, "Composer stays within the narrow workspace"); assert.ok(bounds.unique, "New chat preserves unique SVG fragment IDs");
  await shot(page, "chat-narrow");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator("#chat-empty .kai3d-head-motion").evaluate(el => getComputedStyle(el).animationName), "none");
  assert.deepEqual(failedArt, []); assert.deepEqual(errors, []);
});

test("KAI character: transparent compact layout and expressions follow actual controller states", { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-brand-mascot-"));
  const fixture = await require("./fixtures/mascot-server").startMascotServer(dir);
  const { chromium } = require("playwright-core"); let browser;
  t.after(async () => { await browser?.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 248, height: 304 }, deviceScaleFactor: 2 });
  await page.addInitScript(() => { window.kaiDesktop = { expand: async () => ({}), onEvent: () => () => {}, regions() {}, startDrag() {}, endDrag() {}, cancelAction() {} }; });
  await page.goto(fixture.origin + "/mascot.html");
  await page.waitForSelector("#kai-art svg image");
  if (await page.locator("#later-natural").isVisible()) await page.click("#later-natural");
  await page.evaluate(() => new Promise((resolve, reject) => { const img = new Image(); img.onload = resolve; img.onerror = reject; img.src = "assets/kai-character.png"; }));
  assert.equal(await page.locator("#conversation").isVisible(), false);
  assert.equal(await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
  // These are visual state fixtures. The existing microphone/audio browser
  // suite proves when the controller enters speaking/listening/voicing.
  for (const state of ["idle", "listening", "thinking", "voicing", "speaking"]) {
    await page.evaluate(state => { document.body.dataset.state = state; }, state);
    assert.equal(await page.locator(".kai3d-mouth").evaluate(el => getComputedStyle(el).opacity), state === "speaking" ? "1" : "0");
    await shot(page, "mascot-" + state, { omitBackground: true });
  }
  await page.evaluate(() => { document.body.dataset.state = "idle"; });
  await page.setViewportSize({ width: 660, height: 560 }); await page.click("#toggle-chat");
  await shot(page, "mascot-chat", { omitBackground: true });
  await page.click("#voice-options"); await shot(page, "mascot-voice", { omitBackground: true });
  await page.evaluate(() => document.body.classList.add("motion-off"));
  assert.equal(await page.locator(".kai3d-head-motion").evaluate(el => getComputedStyle(el).animationName), "none");
});

test("KAI pickup, edge poses and search props coexist with chat and reduced motion", { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-interaction-"));
  const fixture = await require("./fixtures/mascot-server").startMascotServer(dir);
  const { chromium } = require("playwright-core"); let browser;
  t.after(async () => { await browser?.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 248, height: 304 }, deviceScaleFactor: 2 });
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    window.__dragEnds = []; window.__regions = [];
    window.kaiDesktop = { expand: async () => ({}), onEvent: fn => { window.__kaiEvent = fn; }, regions: r => { window.__regions = r; },
      startDrag() {}, endDrag: cancelled => window.__dragEnds.push(cancelled), cancelAction() {} };
  });
  await page.goto(fixture.origin + "/mascot.html");
  await page.waitForFunction(() => document.querySelector("#model").value === "tiny-live" && document.querySelector("#kai-art svg"));
  if (await page.locator("#later-natural").isVisible()) await page.click("#later-natural");
  await page.evaluate(() => new Promise((resolve, reject) => { const i = new Image(); i.onload = resolve; i.onerror = reject; i.src = "assets/kai-character.png"; }));
  const pose = async value => page.evaluate(value => window.__kaiEvent({ type: "placement", value }), value);
  const capture = async name => {
    await page.evaluate(() => { document.body.classList.remove("waving", "landing"); for (const a of document.getAnimations()) { a.pause(); a.currentTime = 1200; } });
    await shot(page, "interactive-" + name, { omitBackground: true, animations: "allow" });
    await page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
  };
  await page.mouse.move(123, 100); await page.mouse.down();
  assert.equal(await page.getAttribute("body", "data-pose"), "carried");
  await page.mouse.move(160, 130);
  await pose({ pose: "carried", moving: true, sway: 12 });
  assert.equal(await page.getAttribute("body", "data-state"), "idle", "Pickup leaves the conversation state intact");
  assert.equal(await page.locator(".kai3d-mouth").evaluate(el => getComputedStyle(el).opacity), "0");
  await capture("carried"); await page.mouse.up();
  await pose({ pose: "free", landed: true });
  assert.equal(await page.locator("body.landing").count(), 1);
  assert.equal(await page.locator("#conversation").isVisible(), false, "A drag is never mistaken for a chat click");
  await page.waitForFunction(() => !document.body.classList.contains("landing"));
  await capture("free");
  for (const physical of ["free", "perched"]) {
    await pose({ pose: physical });
    for (const time of [650, 1450]) {
      await page.evaluate(time => {
        document.body.classList.add("waving");
        for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime = time; }
      }, time);
      const wave = await page.evaluate(() => {
        const arm = document.querySelector(".kai3d-arm-left"), forearm = document.querySelector(".kai3d-forearm-left"), palm = document.querySelector(".kai3d-wave-palm");
        const elbow = new DOMPoint(260, 850).matrixTransform(forearm.getScreenCTM());
        return { shoulder: new DOMMatrix(getComputedStyle(arm).transform).a, palm: getComputedStyle(document.querySelector(".kai3d-wave-forearm")).opacity,
          palmAboveElbow: palm.getBoundingClientRect().bottom < elbow.y };
      });
      assert.ok(wave.shoulder > .5, "Shoulder stays below 60 degrees instead of flipping backward");
      assert.equal(wave.palm, "1"); assert.ok(wave.palmAboveElbow, "The forward-facing open palm stays above the bent elbow");
      await shot(page, "wave-" + physical + "-" + time, { omitBackground: true, animations: "allow" });
      await page.evaluate(() => { document.body.classList.remove("waving"); for (const a of document.getAnimations()) a.play(); });
    }
  }
  for (const physical of ["free", "perched"]) {
    await pose({ pose: physical });
    for (const activity of ["idle", "thinking", "searching", "speaking"]) {
      await page.evaluate(state => { document.body.dataset.state = state; }, activity);
      assert.equal(await page.locator(".kai3d-search-props").evaluate(el => getComputedStyle(el).opacity), activity === "searching" ? "1" : "0");
      await capture(physical + "-" + activity);
    }
    const boxes = await page.evaluate(() => window.__regions);
    assert.ok(boxes.every(r => r.x >= 0 && r.y >= 0 && r.x + r.width <= 248 && r.y + r.height <= 304));
  }
  await page.evaluate(() => { document.body.dataset.state = "idle"; });
  await page.mouse.move(123, 200); await page.mouse.down();
  await pose({ pose: "carried", moving: true, offsetY: 70 });
  assert.equal(await page.locator("#robot").evaluate(el => getComputedStyle(el).transform), "matrix(1, 0, 0, 1, 0, 70)");
  await pose({ pose: "free", cancelled: true }); await page.mouse.up();
  assert.equal(await page.getAttribute("body", "data-pose"), "free");
  assert.equal(await page.evaluate(() => window.__dragEnds.at(-1)), true);
  // A normal click remains a chat toggle after a cancelled pickup.
  await page.setViewportSize({ width: 660, height: 560 });
  await page.click("#robot", { position: { x: 122, y: 100 } });
  assert.equal(await page.locator("#conversation").isVisible(), true);
  fixture.state.tools = [{ name: "web_search", description: "Search the web", params: { query: "search words" }, enabled: true }];
  fixture.state.actions = [{ tool: "web_search", args: { query: "Paris weather tomorrow" } }, { answer: true }];
  let releaseSearch;
  await page.route("**/core/tools/call", route => new Promise(resolve => { releaseSearch = async () => {
    await route.fulfill({ json: { ok: true, result: "Tomorrow in Paris: 22 C. https://weather.example/forecast" } }); resolve();
  }; }));
  await page.fill("#question", "What is the weather tomorrow in Paris?"); await page.press("#question", "Enter");
  await page.waitForFunction(() => document.body.dataset.state === "searching");
  assert.equal(await page.locator(".kai3d-search-props").evaluate(el => getComputedStyle(el).opacity), "1");
  await releaseSearch(); await page.waitForFunction(() => document.getElementById("stop").hidden);
  assert.equal(await page.getAttribute("body", "data-state"), "idle");
  await pose({ pose: "perched" });
  await page.evaluate(() => { document.body.dataset.state = "thinking"; });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".kai3d-arm-left").evaluate(el => getComputedStyle(el).animationName), "none");
  assert.equal(await page.locator(".kai3d-body").evaluate(el => getComputedStyle(el).transform), "matrix(1, 0, 0, 1, 0, 430)");
  await capture("reduced-motion");
  await pose({ pose: "carried" });
  await page.evaluate(() => window.__kaiEvent({ type: "suspend", value: true }));
  assert.equal(await page.locator(".kai3d-puppet").evaluate(el => getComputedStyle(el).animationName), "none");
  assert.deepEqual(errors, []);
});
