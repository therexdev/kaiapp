"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const { startMascotServer } = require("./fixtures/mascot-server");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium-1169/chrome-linux/chrome";
test("Pocket is opt-in, streams audibly before inference completes, preserves effects and stops on hide", { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-pocket-ui-")), fixture = await startMascotServer(dir);
  const browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  t.after(async () => { await browser.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 660, height: 560 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-mascot-cute-default-v1", "1"); localStorage.setItem("kai-mascot-voice-choice", "system");
    const events = new Set(); window.__pocket = { setup: 0, cancelled: 0, available: false, finished: false, generated: 0 };
    let pending;
    window.kaiDesktop = { expand: async () => ({}), regions() {}, onEvent(fn) { events.add(fn); return () => events.delete(fn); },
      windowsVoices: async () => ({ supported: true, voices: [{ id: "zira", name: "Microsoft Zira", lang: "en-US" }] }),
      pocketStatus: async () => ({ supported: true, available: window.__pocket.available, voices: [{ id: "alba", name: "Alba" }], setup: { state: "idle" } }),
      pocketSetup: async () => { window.__pocket.setup++; window.__pocket.available = true; }, pocketWarm: async () => {},
      cancelPocketSpeech: async () => { window.__pocket.cancelled++; if (pending) { clearInterval(pending.timer); pending.reject(new Error("Stopped")); pending = null; } },
      releasePocket: async () => window.kaiDesktop.cancelPocketSpeech(),
      pocketSpeech: request => new Promise((resolve, reject) => {
        window.__pocket.generated++; window.__pocket.finished = false; let at = 0;
        const timer = setInterval(() => {
          if (at >= 12) { clearInterval(timer); pending = null; window.__pocket.finished = true; resolve({ firstMs: 100, audioSeconds: 2.88 }); return; }
          const samples = Float32Array.from({ length: 5760 }, (_, i) => .2 * Math.sin(2 * Math.PI * 220 * (at * 5760 + i) / 24000)); at++;
          for (const fn of events) fn({ type: "pocket-audio", value: { id: request.id, rate: 24000, samples } });
        }, 100); pending = { timer, reject };
      }),
    };
    window.__suspend = () => { for (const fn of events) fn({ type: "suspend", value: true }); };
  });
  await page.goto(fixture.origin + "/mascot.html"); await page.waitForFunction(() => document.querySelector("#model").value);
  assert.equal(await page.locator("#voice-choice").inputValue(), "system"); assert.equal(await page.evaluate(() => window.__pocket.setup), 0);
  await page.locator("#toggle-chat").click(); await page.locator("#voice-options").click();
  for (const viewport of [{ width: 660, height: 560 }, { width: 600, height: 500 }]) {
    await page.setViewportSize(viewport);
    const visible = await page.locator("#setup-pocket").evaluate(button => {
      const r = button.getBoundingClientRect(), panel = document.querySelector("#voice-options-panel"), p = panel.getBoundingClientRect();
      return { inside: r.top >= p.top && r.bottom <= p.bottom && r.right <= p.right, scroll: panel.scrollTop,
        clickable: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === button,
        background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color };
    });
    assert.equal(visible.inside, true, "Download is in the first visible panel, including narrow windows");
    assert.equal(visible.scroll, 0, "No automated scrolling hides the original discovery bug");
    assert.equal(visible.clickable, true);
    assert.notEqual(visible.background, "rgba(0, 0, 0, 0)"); assert.notEqual(visible.background, visible.color);
    if (process.env.KAI_MASCOT_QA_DIR) {
      fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, "pocket-download-" + viewport.width + ".png") });
    }
  }
  await page.setViewportSize({ width: 660, height: 560 });
  await page.locator("#setup-pocket").click();
  await page.waitForFunction(() => !document.querySelector("#setup-pocket").disabled);
  assert.equal(await page.locator("#voice-choice").inputValue(), "system", "Download alone keeps the current voice");
  await page.locator("#preview-pocket").click();
  assert.equal(await page.locator("#voice-choice").inputValue(), "pocket:alba");
  assert.equal(await page.locator("#speech-start").isDisabled(), true);
  await page.waitForFunction(() => document.body.dataset.state === "speaking");
  assert.equal(await page.evaluate(() => window.__pocket.finished), false, "Audio starts while later chunks are still being generated");
  await page.waitForFunction(() => document.querySelector("#pocket-metric").textContent.includes("no buffering pauses"));
  assert.equal(await page.evaluate(() => localStorage.getItem("kai-mascot-voice-choice")), "pocket:alba");
  await page.locator("#preview-voice").click(); await page.waitForFunction(() => window.__pocket.generated === 2);
  await page.evaluate(() => window.__suspend()); await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => window.__pocket.cancelled) > 0);
  assert.notEqual(await page.locator("body").getAttribute("data-state"), "speaking");
  assert.deepEqual(errors, []);
});


test("Missing Pocket voice has a compact download action, progress and retry without opening chat", { skip: !fs.existsSync(CHROMIUM), timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-pocket-setup-")), fixture = await startMascotServer(dir);
  const browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 660, height: 560 } });
  await page.addInitScript(() => {
    localStorage.setItem("kai-mascot-cute-default-v1", "1"); localStorage.setItem("kai-mascot-voice-choice", "pocket:alba"); localStorage.setItem("kai-mascot-voice", "0");
    window.__setup = { calls: 0, available: false, state: "idle", pct: 0 };
    window.kaiDesktop = { expand: async () => ({}), regions: boxes => { window.__regions = boxes; }, onEvent() { return () => {}; },
      pocketWarm: async () => {}, releasePocket: async () => {}, cancelPocketSpeech: async () => {},
      pocketStatus: async () => ({ supported: true, available: window.__setup.available, voices: [{ id: "alba", name: "Alba" }],
        setup: { state: window.__setup.state, pct: window.__setup.pct, error: "Connection interrupted. Try again." } }),
      pocketSetup: async () => { window.__setup.calls++; window.__setup.state = "downloading"; window.__setup.pct = 25; },
    };
  });
  await page.goto(fixture.origin + "/mascot.html"); await page.waitForFunction(() => document.querySelector("#model").value);
  await page.locator("#toggle-chat").click(); await page.locator("#read-aloud").click();
  await page.locator("#collapse").click(); await page.setViewportSize({ width: 248, height: 304 });
  assert.equal(await page.locator("#pocket-card").isVisible(), true);
  const button = await page.locator("#compact-pocket").boundingBox(); assert.ok(button.y + button.height < 304);
  assert.equal(await page.evaluate(() => window.__setup.calls), 0, "Missing voice never downloads automatically");
  await page.locator("#compact-pocket").click();
  assert.equal(await page.locator("#compact-pocket").isDisabled(), true);
  assert.match(await page.locator("#pocket-card-copy").textContent(), /25%/);
  await page.evaluate(() => { window.__setup.state = "error"; });
  await page.waitForFunction(() => document.querySelector("#compact-pocket").textContent === "Retry download");
  await page.locator("#compact-pocket").click();
  assert.equal(await page.evaluate(() => window.__setup.calls), 2);
  await page.evaluate(() => { window.__setup.state = "done"; window.__setup.available = true; });
  await page.waitForFunction(() => document.querySelector("#compact-pocket").textContent === "Try Alba");
  assert.equal(await page.locator("#conversation").isVisible(), false, "Setup can finish with the chat closed");
  const hit = await page.locator("#compact-pocket").evaluate(button => { const r = button.getBoundingClientRect(); return window.__regions.some(b => r.x >= b.x && r.y >= b.y && r.right <= b.x + b.width && r.bottom <= b.y + b.height); });
  assert.equal(hit, true, "Native hit regions include the complete compact action");
  if (process.env.KAI_MASCOT_QA_DIR) await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, "pocket-compact-ready.png") });
});
