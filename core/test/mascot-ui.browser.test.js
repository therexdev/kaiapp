"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { startMascotServer } = require("./fixtures/mascot-server");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("KAI desktop UI: chat, persisted history, cancellation, voice, microphone cleanup and animation controls", { skip: !fs.existsSync(CHROMIUM), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mascot-ui-"));
  const fixture = await startMascotServer(dir);
  let browser;
  t.after(async () => { await browser?.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { chromium } = require("playwright-core");
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const context = await browser.newContext({ viewport: { width: 660, height: 560 }, permissions: ["microphone"], deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    window.__spoken = []; window.__streams = []; window.__mainRequests = []; window.__folderRequests = [];
    const timers = [];
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [{ localService: true, lang: "en-US", voiceURI: "test", name: "Test voice" }],
      cancel: () => timers.splice(0).forEach(clearTimeout),
      speak: utterance => { window.__spoken.push(utterance.text); utterance.onstart?.(); timers.push(setTimeout(() => utterance.onend?.(), 30)); },
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => { const stream = await getMedia(options); window.__streams.push(stream); return stream; };
    window.kaiDesktop = {
      expand: async open => { window.__kaiEvent?.({ type: "expanded", value: open }); return { expanded: open }; },
      regions: value => { window.__regions = value; }, startDrag() {}, endDrag() {},
      openMain: view => { window.__mainRequests.push(view); window.__kaiEvent?.({ type: "suspend", value: true }); },
      hide: () => window.__kaiEvent?.({ type: "suspend", value: true }),
      openFolder: async folder => { window.__folderRequests.push(folder); return { status: window.__denyFolder ? "cancelled" : "opened", folder, label: "Pictures" }; },
      cancelAction() {},
      onEvent: callback => { window.__kaiEvent = callback; },
    };
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(fixture.origin + "/mascot.html");
  await page.waitForFunction(() => document.querySelector("#model").value === "tiny-live" && document.querySelector("#kai-art svg"));
  await page.click("#toggle-chat");
  await page.waitForSelector("#conversation:not([hidden])");
  if (process.env.KAI_MASCOT_QA_DIR) {
    fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, "kai-welcome.png"), omitBackground: true, animations: "disabled" });
  }
  // No clipped composer or oversized invisible click blocker around the robot.
  const layout = await page.evaluate(() => ({
    composer: document.querySelector("#composer").getBoundingClientRect().toJSON(),
    panel: document.querySelector("#conversation").getBoundingClientRect().toJSON(), regions: window.__regions,
  }));
  assert.ok(layout.composer.bottom < layout.panel.bottom);
  assert.ok(layout.regions.some(r => r.width < 250 && r.height < 300));
  await page.fill("#question", "Help me plan my day.");
  await page.press("#question", "Enter");
  await page.waitForFunction(() => !!localStorage.getItem("kai-mascot-chat-id") && document.querySelector("#stop").hidden);
  assert.equal(fixture.state.requests[0].model, "tiny-live");
  assert.match(fixture.state.requests[0].messages[0].content, /You are KAI/);
  assert.match(await page.textContent("#messages"), /What are you working on today/);
  assert.equal(fixture.chats.list().length, 1);
  await page.reload();
  await page.waitForSelector(".message.assistant", { state: "attached" });
  await page.click("#toggle-chat");
  await page.waitForSelector(".message.assistant");
  assert.equal(await page.locator(".message.user").count(), 1);
  if (process.env.KAI_MASCOT_QA_DIR) await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, "kai-chat.png"), omitBackground: true, animations: "disabled" });

  fixture.state.delay = 500;
  await page.fill("#question", "Take your time.");
  await page.click("#send");
  await page.waitForSelector(".message.streaming");
  await page.click("#stop");
  await page.waitForFunction(() => document.querySelector("#stop").hidden && !document.querySelector("#send").hidden);
  assert.match(await page.textContent("#notice"), /Stopped|stopped/);
  fixture.state.delay = 10;
  await page.fill("#question", "");

  // A complete sentence speaks while the model is still producing its reply.
  await page.click("#read-aloud");
  fixture.state.delay = 130;
  fixture.state.reply = "Hi friend. I can start speaking while I think through the rest of your question. Here is one more sentence to keep the response streaming.";
  const finishedBefore = fixture.state.finished;
  await page.fill("#question", "Say hello while you think.");
  await page.click("#send");
  await page.waitForFunction(() => window.__spoken.length > 0);
  assert.equal(fixture.state.finished, finishedBefore, "Speech started before the final stream event");
  await page.waitForFunction(() => document.querySelector("#stop").hidden);
  assert.equal((await page.evaluate(() => window.__spoken)).join(" "), fixture.state.reply);
  fixture.state.delay = 10;

  const requestsBeforeFolder = fixture.state.requests.length;
  await page.fill("#question", "Bring up my Pictures folder.");
  await page.click("#send");
  await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("Your Pictures folder is open") && document.querySelector("#stop").hidden);
  assert.equal(fixture.state.requests.length, requestsBeforeFolder, "Folder actions do not rely on model claims");
  assert.deepEqual(await page.evaluate(() => window.__folderRequests), ["pictures"]);
  await page.evaluate(() => { window.__denyFolder = true; });
  await page.fill("#question", "Open my Pictures folder.");
  await page.click("#send");
  await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("left the folder closed") && document.querySelector("#stop").hidden);

  // A real Chromium microphone stream is encoded to WAV and POSTed locally.
  await page.click("#mic");
  await page.waitForFunction(() => document.body.dataset.state === "listening");
  await new Promise(resolve => setTimeout(resolve, 400));
  await page.click("#mic");
  await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("Hello from the microphone.") && document.querySelector("#stop").hidden);
  assert.equal(fixture.state.transcriptions.length, 1);
  assert.equal(fixture.state.transcriptions[0].toString("ascii", 0, 4), "RIFF");
  assert.ok(await page.evaluate(() => window.__spoken.length > 0), "Voice mode speaks the reply");
  assert.ok(await page.evaluate(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended"))));

  await page.click("#voice-options");
  await page.click("#setup-natural");
  await page.waitForFunction(() => document.querySelector("#voice-choice").value === "natural:af_heart");
  await page.click("#preview-voice");
  await page.waitForFunction(() => !document.querySelector("#stop").hidden);
  await page.waitForFunction(() => document.querySelector("#stop").hidden);
  assert.ok(fixture.state.speech.some(s => s.voice === "af_heart"), "Natural voice streams real WAV playback through the browser");
  if (process.env.KAI_MASCOT_QA_DIR) await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, "kai-voice-options.png"), omitBackground: true, animations: "disabled" });
  await page.click("#close-voice-options");

  // Real AudioWorklet capture starts only after opt-in; a compact mascot keeps
  // listening, then Off releases every track. Wake semantics are tested with
  // controlled speech segments in mascot-interaction.test.js.
  await page.click("#wake-toggle");
  await page.waitForFunction(() => document.querySelector("#wake-toggle").getAttribute("aria-pressed") === "true");
  assert.ok(await page.evaluate(() => window.__streams.some(s => s.getTracks().some(t => t.readyState === "live"))));
  await page.click("#collapse");
  assert.equal(await page.getAttribute("#quick-wake", "aria-pressed"), "true");
  await page.click("#quick-wake");
  await page.waitForFunction(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended")));
  await page.click("#toggle-chat");
  await page.click("#wake-toggle");
  await page.waitForFunction(() => document.querySelector("#wake-toggle").getAttribute("aria-pressed") === "true");
  await page.click("#main-app");
  await page.waitForFunction(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended")));
  assert.equal(await page.getAttribute("#wake-toggle", "aria-pressed"), "false");
  await page.evaluate(() => window.__kaiEvent({ type: "suspend", value: false }));

  // Opening the full app while listening must release the device and discard
  // the unfinished recording; it must never submit after the mascot is hidden.
  await page.click("#mic");
  await page.waitForFunction(() => document.body.dataset.state === "listening");
  await page.click("#main-app");
  assert.ok(await page.evaluate(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended"))));
  assert.equal(fixture.state.transcriptions.length, 1);
  await page.evaluate(() => window.__kaiEvent({ type: "suspend", value: false }));
  await page.click("#mascot-menu-button");
  await page.click("#motion");
  assert.ok(await page.locator("body").evaluate(el => el.classList.contains("motion-off")));
  await page.click("#mascot-menu-button");
  await page.click("#new-chat");
  assert.equal(await page.locator(".message").count(), 0);
  assert.ok(fixture.chats.list().length >= 1, "New conversation retains prior history");
  assert.deepEqual(errors, []);
});
