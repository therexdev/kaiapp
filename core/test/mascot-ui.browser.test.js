"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { startMascotServer } = require("./fixtures/mascot-server");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("KAI UI: natural default, compact voice, follow-ups, barge-in context, history and microphone cleanup", { skip: !fs.existsSync(CHROMIUM), timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-mascot-ui-"));
  const fixture = await startMascotServer(dir);
  let browser;
  t.after(async () => { await browser?.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { chromium } = require("playwright-core");
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const context = await browser.newContext({ viewport: { width: 660, height: 560 }, permissions: ["microphone"], deviceScaleFactor: 2 });
  await context.addInitScript(() => {
    window.__spoken = []; window.__streams = []; window.__mainRequests = []; window.__folderRequests = [];
    window.__audio = []; window.__pauses = 0; window.__toneMedia = true;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(...args) { super(...args); window.__audio.push(this); }
      pause() { if (!this.paused && !this.ended) window.__pauses++; super.pause(); }
    };
    const timers = [];
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [{ localService: true, lang: "en-US", voiceURI: "test", name: "Test voice" }],
      cancel: () => timers.splice(0).forEach(clearTimeout), pause() {}, resume() {},
      speak: utterance => { window.__spoken.push(utterance.text); timers.push(setTimeout(() => utterance.onend?.(), 30)); },
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      const device = await getMedia(options); window.__streams.push(device);
      if (!window.__toneMedia) return device;
      device.getTracks().forEach(t => t.stop());
      // Controlled speech activity, through a real MediaStream and AudioWorklet.
      // ASR text is supplied by the local HTTP fixture, not claimed as real ASR.
      const ctx = new AudioContext(), oscillator = ctx.createOscillator(), gain = ctx.createGain();
      const destination = ctx.createMediaStreamDestination();
      gain.gain.value = 0; oscillator.frequency.value = 240;
      oscillator.connect(gain); gain.connect(destination); oscillator.start(); await ctx.resume();
      window.__gain = gain;
      const stream = destination.stream;
      stream.getTracks().forEach(track => {
        const stop = track.stop.bind(track);
        track.stop = () => { stop(); ctx.close().catch(() => {}); };
      });
      window.__streams.push(stream); return stream;
    };
    window.kaiDesktop = {
      expand: async open => { window.__kaiEvent?.({ type: "expanded", value: open }); return { expanded: open }; },
      regions: value => { window.__regions = value; }, startDrag() {}, endDrag() {},
      openMain: view => { window.__mainRequests.push(view); window.__kaiEvent?.({ type: "suspend", value: true }); },
      hide: () => window.__kaiEvent?.({ type: "suspend", value: true }),
      openFolder: async folder => { window.__folderRequests.push(folder); return { status: window.__denyFolder ? "cancelled" : "opened", folder, label: "Pictures" }; },
      cancelAction() {}, onEvent: callback => { window.__kaiEvent = callback; },
    };
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const compact = async () => assert.equal(await page.locator("#conversation").evaluate(el => el.hidden), true);
  const idle = () => page.waitForFunction(() => document.querySelector("#stop").hidden && !document.querySelector("#send").hidden);
  const utterance = async text => {
    fixture.state.transcript = text;
    await page.evaluate(() => { window.__gain.gain.value = .06; });
    await page.waitForTimeout(400);
    await page.evaluate(() => { window.__gain.gain.value = 0; });
  };
  const screenshot = async name => {
    if (!process.env.KAI_MASCOT_QA_DIR) return;
    fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, name + ".png"), omitBackground: true, animations: "disabled" });
  };
  await page.goto(fixture.origin + "/mascot.html");
  await page.waitForFunction(() => document.querySelector("#model").value === "tiny-live" && document.querySelector("#kai-art svg"));
  await compact(); assert.equal(await page.evaluate(() => window.__streams.length), 0);
  assert.equal(await page.inputValue("#voice-choice"), "natural:af_heart");
  await page.click("#quick-mic");
  await page.waitForSelector("#natural-card:not([hidden])");
  await compact(); assert.equal(await page.evaluate(() => window.__spoken.length), 0, "No silent fallback to legacy computer speech");
  await screenshot("kai-compact-voice-setup");
  await page.click("#compact-natural");
  await page.waitForSelector("#natural-card", { state: "hidden" });
  assert.equal(await page.getAttribute("#quick-wake", "aria-pressed"), "true");
  await utterance("Help me plan a trip to Seattle.");
  await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("What are you working on today"));
  await idle(); await compact();
  assert.equal(fixture.state.requests.length, 1); assert.ok(fixture.state.speech.some(s => s.voice === "af_heart"));
  assert.equal(fixture.state.transcriptions[0].toString("ascii", 0, 4), "RIFF");
  assert.equal(await page.evaluate(() => window.__spoken.length), 0);
  await utterance("What should I pack for that trip?");
  await page.waitForFunction(() => document.querySelectorAll(".message.user").length === 2); await idle();
  assert.ok(fixture.state.requests[1].messages.some(m => m.content.includes("trip to Seattle")), "Follow-up retains the earlier question without a wake phrase");
  await compact(); await screenshot("kai-compact-conversation");

  // A long real WAV plays while SSE is still streaming. Speech onset must
  // pause it before ASR finishes, then cancel the old stream and retain context.
  fixture.state.delay = 160; fixture.state.speechSeconds = 6;
  fixture.state.reply = "Seattle is a lovely choice. I would start with a few layers for the weather and comfortable shoes for walking. There are several neighborhoods to explore, and I can help you make a plan for each day of your trip.";
  await utterance("Tell me more about the neighborhoods.");
  await page.waitForFunction(() => window.__audio.some(a => !a.paused && !a.ended));
  assert.ok(await page.locator(".message.streaming").count(), "Voice starts during text streaming");
  const pausedBefore = await page.evaluate(() => window.__pauses), cancelledBefore = fixture.state.cancelled;
  await utterance("Actually, make it a two day trip.");
  assert.ok(await page.evaluate(() => window.__pauses) > pausedBefore, "Audio paused at voice onset before the silence endpoint");
  await page.waitForFunction(() => document.querySelectorAll(".message.user").length === 4);
  assert.ok(fixture.state.cancelled > cancelledBefore, "Confirmed interruption cancels the previous stream");
  const followup = fixture.state.requests.at(-1).messages;
  assert.equal(followup.at(-1).content, "Actually, make it a two day trip.");
  assert.ok(followup.some(m => m.content.includes("trip to Seattle")));
  assert.ok(followup.some(m => m.role === "assistant" && m.content.includes("Seattle is a lovely choice")), "Partial assistant context survives interruption");
  await compact();
  await page.click("#quick-stop"); await idle();
  fixture.state.delay = 10; fixture.state.speechSeconds = .2;
  fixture.state.reply = "Absolutely. What are you working on today?";

  await utterance("That's all.");
  await page.waitForFunction(() => document.querySelector("#mood-label").textContent.includes("Hey KAI"));
  const ambientBefore = fixture.state.requests.length, transcribedBefore = fixture.state.transcriptions.length;
  await utterance("Private background conversation.");
  await page.waitForTimeout(700);
  assert.ok(fixture.state.transcriptions.length > transcribedBefore); assert.equal(fixture.state.requests.length, ambientBefore);
  await utterance("Hey Kay, bring up my Pictures folder.");
  await page.waitForFunction(() => window.__folderRequests.length === 1); await idle();
  assert.equal(fixture.state.requests.length, ambientBefore, "Approved folders bypass the model");
  await page.evaluate(() => { window.__denyFolder = true; });
  await utterance("Open my Pictures folder.");
  await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("left the folder closed")); await idle();
  await utterance("Stop listening.");
  await page.waitForFunction(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended")));
  assert.equal(await page.getAttribute("#quick-wake", "aria-pressed"), "false");
  await compact();

  // A user's click during asynchronous launch/model loading wins over the
  // compact launch default; late history loading must not close the panel.
  fixture.state.modelsDelay = 700;
  await page.evaluate(() => { window.__launchTask = window.__kaiEvent({ type: "launch", value: {} }); });
  await page.click("#toggle-chat");
  await page.evaluate(() => window.__launchTask);
  assert.equal(await page.locator("#conversation").evaluate(el => el.hidden), false);
  fixture.state.modelsDelay = 0;
  const layout = await page.evaluate(() => ({ composer: document.querySelector("#composer").getBoundingClientRect().toJSON(),
    panel: document.querySelector("#conversation").getBoundingClientRect().toJSON(), regions: window.__regions }));
  assert.ok(layout.composer.bottom < layout.panel.bottom); assert.ok(layout.regions.some(r => r.width < 250 && r.height < 300));
  await screenshot("kai-chat");
  await page.click("#voice-options");
  assert.ok(await page.locator("#wake-toggle").evaluate(el => {
    const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }));
  await page.click("#preview-voice"); await page.waitForFunction(() => !document.querySelector("#stop").hidden); await idle();
  await screenshot("kai-voice-options");
  // Named OS voices remain an explicit choice; sentence streaming stays exact.
  await page.selectOption("#voice-choice", "system:test"); await page.click("#close-voice-options");
  fixture.state.delay = 130;
  fixture.state.reply = "Hi friend. I can start speaking while I think through the rest of your question. Here is one more sentence to keep the response streaming.";
  const finishedBefore = fixture.state.finished;
  await page.fill("#question", "Say hello while you think."); await page.click("#send");
  await page.waitForFunction(() => window.__spoken.length > 0);
  assert.equal(fixture.state.finished, finishedBefore); await idle();
  assert.equal((await page.evaluate(() => window.__spoken)).join(" "), fixture.state.reply);
  fixture.state.delay = 10;
  const countBeforeReload = await page.locator(".message.user").count();
  await page.reload(); await page.waitForSelector(".message.assistant", { state: "attached" }); await compact();
  assert.equal(await page.locator(".message.user").count(), countBeforeReload);
  // Collapse is independent of the microphone; return/hide releases all tracks.
  await page.click("#quick-wake"); await page.waitForFunction(() => document.querySelector("#quick-wake").getAttribute("aria-pressed") === "true");
  await page.click("#toggle-chat"); await page.click("#collapse");
  assert.equal(await page.getAttribute("#quick-wake", "aria-pressed"), "true");
  await page.click("#mascot-menu-button"); await page.click("#menu-open-app");
  await page.waitForFunction(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended")));
  assert.equal(await page.getAttribute("#quick-wake", "aria-pressed"), "false");
  await page.evaluate(() => window.__kaiEvent({ type: "suspend", value: false }));
  await page.click("#toggle-chat"); await page.click("#new-chat");
  assert.equal(await page.locator(".message").count(), 0); assert.ok(fixture.chats.list().length >= 1);
  await page.click("#mascot-menu-button"); await page.click("#motion");
  assert.ok(await page.locator("body").evaluate(el => el.classList.contains("motion-off")));
  assert.deepEqual(errors, []);
});
