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
  await page.locator("#toggle-chat").click(); await page.locator("#voice-options").click(); await page.locator("#setup-pocket").click();
  await page.waitForFunction(() => !document.querySelector("#setup-pocket").disabled);
  await page.locator("#voice-choice").selectOption("pocket:alba"); assert.equal(await page.locator("#speech-start").isDisabled(), true);
  await page.locator("#preview-voice").click();
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
