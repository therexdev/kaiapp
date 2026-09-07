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
    if (!localStorage.getItem("kai-mascot-natural-default-v3")) localStorage.setItem("kai-mascot-voice-choice", "system:test");
    window.__spoken = []; window.__streams = []; window.__mainRequests = []; window.__folderRequests = [];
    window.__audio = []; window.__pauses = 0; window.__toneMedia = true; window.__roomNoise = .008;
    const NativeAudio = window.Audio;
    window.Audio = class extends NativeAudio {
      constructor(...args) { super(...args); window.__audio.push(this); }
      async play() { if (window.__playDelay) await new Promise(r => setTimeout(r, window.__playDelay)); return super.play(); }
      pause() { if (!this.paused && !this.ended) window.__pauses++; super.pause(); }
    };
    const timers = [];
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [{ localService: true, lang: "en-US", voiceURI: "test", name: "Test voice" }],
      cancel: () => timers.splice(0).forEach(clearTimeout), pause() {}, resume() {},
      speak: utterance => { window.__spoken.push(utterance.text); utterance.onstart?.(); timers.push(setTimeout(() => utterance.onend?.(), 30)); },
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
      gain.gain.value = window.__roomNoise; oscillator.frequency.value = 240;
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
      navigate: async view => { window.__mainRequests.push(view); return { ok: true, view }; },
      confirmTool: async (name, args) => { (window.__toolApprovals ||= []).push({ name, args }); return window.__allowTool === true; },
      hide: () => window.__kaiEvent?.({ type: "suspend", value: true }),
      openFolder: async folder => { window.__folderRequests.push(folder); return { status: window.__denyFolder ? "cancelled" : "opened", folder, label: "Pictures" }; },
      cancelAction() {}, onEvent: callback => { window.__kaiEvent = callback; },
    };
  });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const compact = async () => assert.equal(await page.locator("#conversation").evaluate(el => el.hidden), true);
  const idle = () => page.waitForFunction(() => document.querySelector("#stop").hidden && !document.querySelector("#send").hidden);
  const utterance = async (text, duration = 400) => {
    fixture.state.transcript = text;
    await page.evaluate(() => { window.__gain.gain.value = .06; });
    await page.waitForTimeout(duration);
    await page.evaluate(() => { window.__gain.gain.value = window.__roomNoise; });
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
  fixture.state.naturalError = "KAI's natural voice couldn't start. Try setting it up again. Your downloaded voices will be reused.";
  await page.click("#compact-natural");
  await page.waitForFunction(() => document.querySelector("#compact-natural").textContent === "Retry natural voice" && !document.querySelector("#compact-natural").disabled);
  assert.match(await page.textContent("#natural-card-copy"), /couldn't start/);
  assert.doesNotMatch(await page.textContent("#natural-card-copy"), /Starting|Warming/);
  assert.equal(await page.evaluate(() => window.__spoken.length), 0);
  await compact(); await screenshot("kai-natural-voice-retry");
  fixture.state.naturalError = null;
  await page.click("#compact-natural");
  await page.waitForSelector("#natural-card", { state: "hidden" });
  assert.equal(await page.getAttribute("#quick-wake", "aria-pressed"), "true");
  await page.waitForTimeout(1700);
  assert.equal(fixture.state.transcriptions.length, 0, "Steady room noise must not start a transcription loop");
  const streamCount = await page.evaluate(() => window.__streams.length);
  assert.equal(await page.inputValue("#mic-sensitivity"), "tv");
  assert.equal(await page.inputValue("#voice-tone"), "kai");
  fixture.state.speechDelay = 900; fixture.state.speechSeconds = .6;
  await page.evaluate(() => { window.__playDelay = 350; });
  const firstSpeech = page.waitForRequest(r => r.url().endsWith("/core/speech") && r.method() === "POST");
  await utterance("Help me plan a trip to Seattle.");
  await firstSpeech;
  await page.waitForTimeout(150);
  assert.equal(await page.getAttribute("body", "data-state"), "voicing", "Text/ASR state changes must not animate an inaudible queued voice");
  await page.waitForFunction(() => window.__audio.length > 0);
  assert.notEqual(await page.getAttribute("body", "data-state"), "speaking", "Preparing the audio element is not audible playback");
  await page.waitForFunction(() => document.body.dataset.state === "speaking" && window.__audio.some(a => !a.paused && !a.ended));
  fixture.state.speechDelay = 0;
  await page.evaluate(() => { window.__playDelay = 0; });
  await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("What are you working on today"));
  await idle(); await compact();
  assert.equal(fixture.state.requests.length, 1); assert.ok(fixture.state.speech.some(s => s.voice === "af_heart"));
  assert.ok(fixture.state.warms > 0, "Warm the installed voice while the model thinks");
  fixture.state.speechSeconds = .2;
  assert.equal(fixture.state.transcriptions[0].toString("ascii", 0, 4), "RIFF");
  assert.equal(await page.evaluate(() => window.__spoken.length), 0);
  await utterance("What should I pack for that trip?");
  await page.waitForFunction(() => document.querySelectorAll(".message.user").length === 2); await idle();
  assert.ok(fixture.state.requests[1].messages.some(m => m.content.includes("trip to Seattle")), "Follow-up retains the earlier question without a wake phrase");
  await compact(); await screenshot("kai-compact-conversation");

  // Buffered complete sentences play while SSE is still streaming. Only
  // recognized KAI interruptions cancel the old stream and retain context.
  fixture.state.delay = 350; fixture.state.speechSeconds = 6;
  fixture.state.reply = "Seattle is a lovely choice. I would start with a few layers for the weather and comfortable shoes for walking. There are several neighborhoods to explore, and I can help you make a plan for each day of your trip. We can spend the first day exploring the waterfront and the market before heading up the hill. There are also museums to visit when the weather turns rainy, with many interesting things to see. Tell me which places interest you most and we will build a comfortable schedule together.";
  await utterance("Tell me more about the neighborhoods.");
  await page.waitForFunction(() => window.__audio.some(a => !a.paused && !a.ended));
  assert.ok(await page.locator(".message.streaming").count(), "Voice starts during text streaming");
  const guardedPauses = await page.evaluate(() => window.__pauses);
  await utterance("Get out of the car right now.");
  await page.waitForTimeout(700);
  assert.equal(fixture.state.requests.length, 3, "Loud movie dialogue cannot become an interruption with the name guard on");
  assert.equal(await page.evaluate(() => window.__pauses), guardedPauses);
  assert.equal(await page.evaluate(() => window.__streams.length), streamCount, "Recognition reuses one microphone stream");
  const cancelledBefore = fixture.state.cancelled;
  await utterance("KAI, Actually, make it a two day trip.");
  assert.equal(await page.evaluate(() => window.__pauses), guardedPauses, "Sound alone must not pause KAI before name recognition");
  await page.waitForFunction(() => document.querySelectorAll(".message.user").length === 4);
  assert.ok(fixture.state.cancelled > cancelledBefore, "The recognized KAI cue cancels the previous stream");
  const followup = fixture.state.requests.at(-1).messages;
  assert.equal(followup.at(-1).content, "Actually, make it a two day trip.");
  assert.ok(followup.some(m => m.content.includes("trip to Seattle")));
  assert.ok(followup.some(m => m.role === "assistant" && m.content.includes("Seattle is a lovely choice")), "Partial assistant context survives interruption");
  await compact();
  await page.waitForFunction(() => window.__audio.some(a => !a.paused && !a.ended));
  await utterance("KAI.", 180); await idle();
  assert.equal(await page.getAttribute("#quick-mic", "aria-pressed"), "true", "KAI alone stops speaking but keeps the mic on");
  assert.equal(await page.locator(".message.user").count(), 4, "The name alone is not saved as a question");
  await page.evaluate(() => window.__audio.forEach(a => a.dispatchEvent(new Event("playing"))));
  assert.notEqual(await page.getAttribute("body", "data-state"), "speaking", "Late playback events cannot revive stopped animation");
  fixture.state.delay = 10; fixture.state.speechSeconds = .2;
  fixture.state.reply = "Absolutely. What are you working on today?";

  await utterance("What should we eat on the trip?");
  await page.waitForFunction(() => document.querySelectorAll(".message.user").length === 5); await idle();
  assert.equal(fixture.state.requests.at(-1).messages.at(-1).content, "What should we eat on the trip?");
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
  await page.selectOption("#voice-tone", "natural");
  assert.equal(await page.evaluate(() => localStorage.getItem("kai-mascot-voice-tone")), "natural");
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
  // Desktop KAI uses the shared tools without expanding voice chat or
  // submitting a mutation before the person has reviewed it.
  fixture.state.tools = [{ name: "app_read", description: "Read app data", params: { subject: "subject" }, sensitive: false },
    { name: "app_action", description: "App action", params: { action: "action", args: "arguments" }, sensitive: true },
    { name: "web_search", description: "Search the web", params: { query: "query" }, sensitive: false, egress: true }];
  fixture.state.reply = "You have 42.75 KAI, with 1.25 KAI pending in this epoch.";
  await page.click("#toggle-chat");
  await page.fill("#question", "How much KAI have I earned?"); await page.click("#send"); await idle();
  assert.equal(fixture.state.toolCalls.at(-1).args.subject, "earnings");
  assert.ok(fixture.state.requests.at(-1).messages.some(m => m.content.includes('"kai":"42.75"')));
  assert.match(await page.locator(".tool-trace").last().textContent(), /app_read/);
  await screenshot("kai-app-earnings");
  fixture.state.actions = [{ tool: "app_action", args: { action: "stop_earning", args: {} } }];
  const callsBefore = fixture.state.toolCalls.length;
  await page.fill("#question", "Stop earning"); await page.click("#send"); await idle();
  assert.equal(fixture.state.toolCalls.length, callsBefore);
  assert.match(fixture.state.requests.at(-1).messages.map(m => m.content).join("\n"), /User declined/);
  await page.evaluate(() => { window.__allowTool = true; });
  fixture.state.actions = [{ tool: "app_action", args: { action: "stop_earning", args: {} } }];
  await page.fill("#question", "Stop earning"); await page.click("#send"); await idle();
  assert.equal(fixture.state.toolCalls.at(-1).confirmed, true);
  fixture.state.toolResult = "Paris tomorrow: 22 C. https://weather.example/forecast";
  fixture.state.actions = [{ tool: "web_search", args: { query: "Paris tomorrow weather" } }];
  fixture.state.reply = "Tomorrow in Paris is expected to reach 22 degrees Celsius.";
  await page.fill("#question", "What's the weather tomorrow in Paris?"); await page.click("#send"); await idle();
  assert.equal(await page.locator(".tool-sources a").last().getAttribute("href"), "https://weather.example/forecast");
  await page.fill("#question", "Can you open up the application?"); await page.click("#send"); await idle();
  assert.equal((await page.evaluate(() => window.__mainRequests)).at(-1), "chat");
  assert.equal(await page.locator("body").evaluate(el => el.classList.contains("suspended")), false);
  fixture.state.tools = []; await page.click("#collapse");
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
