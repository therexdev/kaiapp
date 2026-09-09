"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { startMascotServer } = require("./fixtures/mascot-server");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("Thinking and search keep an upright grip and one continuous motion timeline, free and perched", { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-expressions-")), fixture = await startMascotServer(dir);
  const browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 248, height: 304 }, deviceScaleFactor: 2 });
  await page.addInitScript(() => {
    window.kaiDesktop = { expand: async () => ({}), regions() {}, onEvent: fn => { window.__kaiEvent = fn; } };
  });
  await page.goto(fixture.origin + "/mascot.html");
  await page.waitForFunction(() => document.querySelector("#kai-art svg") && document.querySelector("#model").value);
  await page.evaluate(() => new Promise((resolve, reject) => { const image = new Image(); image.onload = resolve; image.onerror = reject; image.src = "assets/kai-character.png"; }));
  for (const pose of ["free", "perched"]) {
    await page.evaluate(pose => { window.__kaiEvent({ type: "placement", value: { pose } }); document.body.classList.remove("waving", "landing"); document.body.dataset.state = "thinking"; }, pose);
    await page.waitForTimeout(450);
    const results = await page.evaluate(() => {
      const hand = document.querySelector(".kai3d-curled-hand"), head = document.querySelector(".kai3d-head-motion");
      for (const a of document.getAnimations()) { a.pause(); a.currentTime = 1200; }
      const nod = head.getAnimations()[0];
      const at = (el, x, y) => new DOMPoint(x, y).matrixTransform(el.getScreenCTM());
      const wrist = at(hand, 0, 0), knuckles = at(hand, 0, -80);
      const states = ["searching", "voicing", "transcribing", "thinking"].map(state => {
        document.body.dataset.state = state;
        const position = at(hand, 0, 0);
        return { state, sameTimeline: head.getAnimations()[0] === nod, time: nod.currentTime,
          jump: Math.hypot(position.x - wrist.x, position.y - wrist.y),
          curled: getComputedStyle(document.querySelector(".kai3d-curled-forearm")).opacity,
          original: getComputedStyle(document.querySelector(".kai3d-forearm-left>image")).opacity };
      });
      nod.currentTime = 2999; const before = at(head, 512, 665);
      nod.currentTime = 3001; const after = at(head, 512, 665);
      document.body.dataset.state = "searching";
      const glass = document.querySelector(".kai3d-magnifier"), scan = glass.getAnimations()[0]; scan.pause();
      const grip = at(hand, 0, -40), distances = [0, 1300, 2600].map(time => {
        scan.currentTime = time; const handle = at(glass, 419, 707); return Math.hypot(handle.x - grip.x, handle.y - grip.y);
      });
      return { upright: knuckles.y < wrist.y && Math.abs(knuckles.x - wrist.x) < .1, states,
        loopJump: Math.hypot(before.x - after.x, before.y - after.y), distances };
    });
    assert.equal(results.upright, true, "Knuckles point up, not backward");
    for (const s of results.states) {
      assert.equal(s.sameTimeline, true, s.state); assert.equal(s.time, 1200);
      assert.ok(s.jump < .1, s.state + " must not move the grip");
      assert.equal(s.curled, "1"); assert.equal(s.original, "0");
    }
    assert.ok(results.loopJump < .1, "Nodding loop has no seam");
    assert.ok(results.distances.every(d => d < .5), "Magnifier pivots in the hand instead of jumping away from it");
    if (process.env.KAI_MASCOT_QA_DIR) {
      fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
      for (const state of ["thinking", "searching"]) {
        await page.evaluate(state => { document.body.dataset.state = state; for (const a of document.getAnimations()) { a.pause(); a.currentTime = 1200; } }, state);
        await page.screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, `steady-${pose}-${state}.png`), omitBackground: true });
      }
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".kai3d-head-motion").evaluate(el => getComputedStyle(el).animationName), "none");
  await page.evaluate(() => window.__kaiEvent({ type: "placement", value: { pose: "carried" } }));
  assert.equal(await page.locator(".kai3d-curled-forearm").evaluate(el => getComputedStyle(el).opacity), "0");
});

test("Web planning does not flash back to thinking; every voice receives clean speech while chat keeps sources", { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-spoken-ui-")), fixture = await startMascotServer(dir);
  fixture.state.naturalReady = true;
  const browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 660, height: 560 } }), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("kai-mascot-cute-default-v1", "1"); localStorage.setItem("kai-mascot-voice", "1");
    localStorage.setItem("kai-mascot-voice-choice", "windows:onecore:test");
    window.__nativeSpeech = []; window.__browserSpeech = [];
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [{ localService: true, voiceURI: "browser", name: "Browser test", lang: "en-US" }],
      cancel() {}, resume() {}, speak: u => { window.__browserSpeech.push(u.text); u.onstart?.(); setTimeout(() => u.onend?.(), 5); },
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.kaiDesktop = { expand: async () => ({}), regions() {}, onEvent() {}, cancelAction() {},
      windowsVoices: async () => ({ supported: true, available: true, voices: [{ id: "onecore:test", name: "Native test", lang: "en-US" }] }),
      windowsSpeech: async ({ text }) => { window.__nativeSpeech.push(text); return new Uint8Array(KaiWav.encodeWav16kMono(new Float32Array(1600), 16000)); },
      cancelWindowsSpeech() {},
    };
  });
  await page.goto(fixture.origin + "/mascot.html");
  await page.waitForFunction(() => document.querySelector("#voice-choice").value === "windows:onecore:test" && document.querySelector("#model").value);
  await page.click("#toggle-chat");
  fixture.state.reply = "Tomorrow is sunny. 😊 Bring water [1](https://weather.example/today).\nSources: https://weather.example/today";
  fixture.state.tools = ["web_search", "read_page"].map(name => ({ name, description: name, params: {}, sensitive: false, enabled: true }));
  fixture.state.toolResult = "Sunny tomorrow. https://weather.example/today";
  fixture.state.actions = [{ tool: "web_search", args: { query: "weather" } }, { tool: "read_page", args: { url: "https://weather.example/today" } }, { answer: true }];
  let plans = 0, releasePlanning;
  await page.route("**/core/chat/completions", async route => {
    if (!route.request().postDataJSON().stream && ++plans === 2) await new Promise(resolve => { releasePlanning = resolve; });
    await route.continue();
  });
  await page.evaluate(() => { document.body.classList.add("waving"); window.__moods = [];
    new MutationObserver(records => { if (records.some(r => r.attributeName === "data-state")) window.__moods.push(document.body.dataset.state); }).observe(document.body, { attributes: true });
  });
  await page.fill("#question", "What is tomorrow's weather?"); await page.press("#question", "Enter");
  await page.waitForFunction(() => document.querySelector(".tool-trace").textContent === "Putting it together…");
  assert.equal(await page.getAttribute("body", "data-state"), "searching");
  assert.equal(await page.locator("body.waving").count(), 0);
  releasePlanning();
  await page.waitForFunction(() => document.querySelector("#stop").hidden && document.body.dataset.state === "idle");
  assert.equal((await page.evaluate(() => window.__moods)).filter(s => s === "searching").length, 1, "Search pose starts once across both lookups");
  const expected = "Tomorrow is sunny. smiley face emoji Bring water.";
  assert.equal(await page.evaluate(() => window.__nativeSpeech.join(" ")), expected);
  assert.equal(await page.locator(".tool-sources a").last().getAttribute("href"), "https://weather.example/today");
  assert.match(await page.locator(".message.assistant").last().textContent(), /😊/);
  assert.equal(await page.locator(".message.assistant .content a").last().getAttribute("href"), "https://weather.example/today");
  fixture.state.tools = [];
  for (const choice of ["natural:af_bella", "system:browser"]) {
    await page.click("#voice-options"); await page.selectOption("#voice-choice", choice); await page.click("#close-voice-options");
    await page.fill("#question", "Say that again."); await page.press("#question", "Enter");
    await page.waitForFunction(() => document.querySelector("#stop").hidden && document.body.dataset.state === "idle");
  }
  assert.equal(fixture.state.speech.map(r => r.text).join(" "), expected);
  assert.equal(await page.evaluate(() => window.__browserSpeech.join(" ")), expected);
  assert.deepEqual(errors, []);
});

test("Speaking keeps its gesture and bubble through playback gaps, but closes the mouth and stops promptly", { skip: !fs.existsSync(CHROMIUM), timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-speaking-steady-")), fixture = await startMascotServer(dir);
  fixture.state.reply = "Here is the first sentence. Here is the second sentence.";
  const browser = await require("playwright-core").chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  t.after(async () => { await browser.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 660, height: 560 } });
  await page.addInitScript(() => {
    localStorage.setItem("kai-mascot-cute-default-v1", "1");
    localStorage.setItem("kai-mascot-voice", "1");
    localStorage.setItem("kai-mascot-voice-choice", "system:fixture");
    window.__utterances = [];
    Object.defineProperty(window, "speechSynthesis", { value: {
      getVoices: () => [{ localService: true, voiceURI: "fixture", name: "Test voice", lang: "en-US" }],
      cancel() {}, resume() {}, speak(u) { window.__utterances.push(u); u.onstart?.(); },
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.kaiDesktop = { expand: async () => ({}), regions() {}, onEvent() {}, cancelAction() {} };
  });
  await page.goto(fixture.origin + "/mascot.html");
  await page.waitForFunction(() => document.querySelector("#model").value);
  const width = await page.locator("#status-pill").evaluate(el => el.getBoundingClientRect().width);
  await page.click("#toggle-chat");
  await page.fill("#question", "Say two sentences."); await page.press("#question", "Enter");
  await page.waitForFunction(() => window.__utterances.length === 1 && document.body.dataset.audible === "true");
  await page.evaluate(() => { window.__gesture = document.querySelector(".kai3d-arm-right").getAnimations()[0]; window.__utterances[0].onpause(); });
  assert.equal(await page.locator("body").getAttribute("data-state"), "speaking");
  assert.equal(await page.locator(".kai3d-mouth").evaluate(el => getComputedStyle(el).opacity), "0");
  await page.evaluate(() => { window.__utterances[0].onresume(); window.__utterances[0].onend(); });
  await page.waitForFunction(() => window.__utterances.length === 2 && document.body.dataset.audible === "true");
  assert.equal(await page.evaluate(() => document.querySelector(".kai3d-arm-right").getAnimations()[0] === window.__gesture), true);
  assert.equal(await page.locator("#mood-label").textContent(), "KAI is speaking");
  assert.equal(await page.locator("#status-pill").evaluate(el => el.getBoundingClientRect().width), width);
  await page.click("#quick-stop");
  await page.waitForFunction(() => document.body.dataset.state === "idle");
  assert.equal(await page.locator(".kai3d-mouth").evaluate(el => getComputedStyle(el).opacity), "0");
});
