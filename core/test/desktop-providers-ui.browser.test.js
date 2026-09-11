"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const CHROMIUM = process.env.KAI_TEST_CHROMIUM || "/opt/pw-browsers/chromium";

test("desktop connections UI: settings, provider selection, chat/mascot streaming, restart and removal", { skip: !fs.existsSync(CHROMIUM), timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-provider-ui-"));
  const { createCore } = require("../server");
  const core = await createCore({ dataDir: dir, port: 0, onEvent: () => {} });
  core.settings.set("network.privacyMode", "local-first");
  const base = "http://127.0.0.1:" + await core.start();
  const { chromium } = require("playwright-core");
  let browser;
  t.after(async () => { await browser?.close(); await core.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  browser = await chromium.launch({ executablePath: CHROMIUM, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.addInitScript(() => {
    const listeners = new Set(), timers = new Map();
    const providers = JSON.parse(localStorage.getItem("fixture-provider-metadata") || "null") || [
      { id: "openai", label: "OpenAI", configured: false, models: [] }, { id: "anthropic", label: "Anthropic", configured: false, models: [] },
    ];
    const status = () => ({ ok: true, available: true, blocked: false, providers });
    const save = () => { localStorage.setItem("fixture-provider-metadata", JSON.stringify(providers)); return status(); };
    window.__providerRequests = [];
    window.kaiProviderBridge = {
      status: async () => status(),
      save: async (id, options) => { const p = providers.find(p => p.id === id); p.configured = !!options.key || p.configured; return save(); },
      refresh: async id => { const p = providers.find(p => p.id === id); p.models = [{ id: id === "openai" ? "gpt-fixture" : "claude-fixture", label: id === "openai" ? "GPT Fixture" : "Claude Fixture" }]; return save(); },
      remove: async id => { const p = providers.find(p => p.id === id); p.configured = false; p.models = []; return save(); },
      onChanged: () => () => {},
      onDelta: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      chat: async (id, body) => {
        window.__providerRequests.push(body);
        const text = body.stream === false ? '{"answer":true}' : "Your private provider reply is streaming.";
        let offset = 0;
        const timer = setInterval(() => {
          const chunk = text.slice(offset, offset + 8); offset += 8;
          for (const fn of listeners) fn({ id, content: chunk });
          if (offset >= text.length) { clearInterval(timer); timers.delete(id); for (const fn of listeners) fn({ id, done: true,
            ...(body.stream !== false && window.__limitWarning ? { finishReason: "length", warning: "This long answer is still incomplete. Ask KAI to continue." } : {}) }); }
        }, 20);
        timers.set(id, timer); return { ok: true };
      },
      cancel: async id => { clearInterval(timers.get(id)); timers.delete(id); return { ok: true }; },
    };
    window.kaiDesktop = { expand: async () => ({}), onEvent: () => () => {}, regions() {}, startDrag() {}, endDrag() {}, cancelAction() {} };
  });
  const page = await context.newPage(), errors = [], coreChats = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().endsWith("/core/chat/completions")) coreChats.push(request.postData()); });
  await page.goto(base); await page.click("#nav-settings");
  await page.waitForSelector("#desktop-providers:not([hidden])");
  for (const id of ["openai", "anthropic"]) {
    await page.fill(`#provider-${id}-key`, "synthetic-ui-key-not-real");
    await page.click(`#provider-${id} [data-provider-action=save]`);
    await page.waitForFunction(id => document.querySelector(`#provider-${id} [data-provider-result]`).textContent.startsWith("Saved securely"), id);
    assert.equal(await page.inputValue(`#provider-${id}-key`), "");
    await page.click(`#provider-${id} [data-provider-action=refresh]`);
    await page.waitForFunction(id => document.querySelector(`#provider-${id} [data-provider-state]`).textContent.includes("1 model"), id);
  }
  if (process.env.KAI_MASCOT_QA_DIR) {
    fs.mkdirSync(process.env.KAI_MASCOT_QA_DIR, { recursive: true });
    await page.locator("#desktop-providers").screenshot({ path: path.join(process.env.KAI_MASCOT_QA_DIR, "kai-desktop-providers.png") });
  }
  await page.click("#provider-openai [data-provider-action=use]");
  await page.waitForFunction(() => document.querySelector("#model-pick").value === "desktop:openai:gpt-fixture");
  const statusFrames = await page.evaluate(async () => {
    await refresh();
    document.getElementById("launch-kai").hidden = false;
    const original = window.kaiProviderBridge.status;
    window.kaiProviderBridge.status = async () => { await new Promise(r => setTimeout(r, 180)); return original(); };
    const frames = []; let running = true;
    const sample = () => {
      frames.push({ text: document.getElementById("status-text").textContent, y: document.getElementById("launch-kai").getBoundingClientRect().y });
      if (running) requestAnimationFrame(sample);
    };
    sample(); await refresh(); running = false;
    window.kaiProviderBridge.status = original;
    return frames;
  });
  assert.ok(statusFrames.length > 1);
  assert.ok(statusFrames.every(frame => frame.text === "Desktop provider ready"));
  assert.ok(statusFrames.every(frame => Math.abs(frame.y - statusFrames[0].y) < .1), "Provider refresh must not move Launch KAI");
  await page.fill("#input", "Hello from the desktop."); await page.click("#btn-send");
  await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("Answered by OpenAI") && document.querySelector("#btn-stop").hidden);
  assert.match(await page.textContent("#privacy-note"), /directly to OpenAI/);
  await page.selectOption("#src-pick", "anthropic");
  await page.waitForFunction(() => document.querySelector("#model-pick").value === "desktop:anthropic:claude-fixture");
  await page.fill("#input", "And a follow-up."); await page.click("#btn-send");
  await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("Answered by Anthropic") && document.querySelector("#btn-stop").hidden);
  assert.equal(coreChats.length, 0, "Provider prompts never reach the shared chat endpoint");
  assert.ok((await page.evaluate(() => window.__providerRequests.at(-1).messages)).some(m => m.role === "assistant" && m.content.includes("private provider reply")));
  await page.evaluate(() => { window.__limitWarning = true; });
  await page.fill("#input", "Give me a long answer."); await page.click("#btn-send");
  await page.waitForFunction(() => document.querySelector("#messages").textContent.includes("This long answer is still incomplete") && document.querySelector("#btn-stop").hidden);
  assert.match(await page.locator("#messages").textContent(), /Your private provider reply is streaming/);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#model-pick").value === "desktop:anthropic:claude-fixture");
  await page.click("#nav-settings"); await page.click("#provider-anthropic [data-provider-action=remove]");
  await page.waitForFunction(() => document.querySelector("#provider-anthropic [data-provider-state]").textContent === "Not connected");
  await page.click('[data-view="chat"]');
  await page.waitForFunction(() => document.querySelector("#model-pick").options.length === 0);
  assert.equal(await page.inputValue("#src-pick"), "anthropic", "Removed providers never silently switch to local or network");
  const mascot = await context.newPage();
  await mascot.goto(base + "/mascot.html");
  await mascot.click("#toggle-chat");
  await mascot.waitForFunction(() => [...document.querySelector("#model").options].some(o => o.value === "desktop:openai:gpt-fixture"));
  await mascot.selectOption("#model", "desktop:openai:gpt-fixture");
  await mascot.fill("#question", "Tell me a short story."); await mascot.press("#question", "Enter");
  await mascot.waitForFunction(() => document.querySelector("#messages").textContent.includes("Your private provider reply") && document.querySelector("#stop").hidden);
  const conversation = await mascot.evaluate(() => window.__providerRequests);
  assert.equal(conversation.length, 1, "Ordinary conversation needs one provider completion");
  assert.equal(conversation[0].stream, true, "Ordinary conversation skips tool planning");
  assert.equal(conversation[0].model, "desktop:openai:gpt-fixture");
  await mascot.evaluate(() => { window.__providerRequests.length = 0; });
  await mascot.fill("#question", "Search the web for a synthetic fixture."); await mascot.press("#question", "Enter");
  await mascot.waitForFunction(() => window.__providerRequests.some(r => r.stream === true) && document.querySelector("#stop").hidden);
  const plans = await mascot.evaluate(() => window.__providerRequests);
  assert.ok(plans.some(r => r.stream === false), "KAI planning uses the selected provider");
  assert.ok(plans.filter(r => r.stream === false).every(r => r.max_tokens >= 2048), "Desktop plans no longer use the tiny local-model cap");
  assert.ok(plans.some(r => r.stream === true), "KAI's final answer streams through the provider");
  assert.ok(plans.every(r => r.model === "desktop:openai:gpt-fixture"));
  await mascot.evaluate(() => { window.__limitWarning = true; });
  await mascot.fill("#question", "Give me a long answer."); await mascot.press("#question", "Enter");
  await mascot.waitForFunction(() => document.querySelector("#notice").textContent.includes("This long answer is still incomplete") && document.querySelector("#stop").hidden);
  assert.notEqual(await mascot.locator("body").getAttribute("data-state"), "error");
  assert.match(await mascot.locator("#messages").textContent(), /Your private provider reply is streaming/);
  assert.deepEqual(errors, []);
  const plain = await browser.newPage(); await plain.goto(base); await plain.click("#nav-settings");
  assert.equal(await plain.locator("#desktop-providers").isVisible(), false, "Browser users have no provider settings");
});
