"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Controller, fitSize, validFrame } = require("../../ui/mascot-eyes");
const { MascotEyes } = require("../../electron/mascot-eyes");

const jpeg = suffix => "data:image/jpeg;base64,/9j/" + Buffer.from(String(suffix)).toString("base64");
const frame = (source, detail, at) => ({ source, detail, capturedAt: at, width: detail === "look" ? 1200 : 640,
  height: detail === "look" ? 675 : 360, dataUrl: jpeg(source + detail + at) });
const tick = () => new Promise(resolve => setImmediate(resolve));

function rendererFixture() {
  let now = 1000, timerId = 0;
  const timers = new Map(), calls = [], stopped = [];
  const bridge = {
    eyesModel: async model => ({ kind: "local", label: model, vision: true }),
    eyesEnable: async (source, model) => { calls.push(["enable", source, model]); return { enabled: true, source, model, destination: "local", label: model }; },
    eyesValidate: async (source, model) => { calls.push(["validate", source, model]); return { enabled: true }; },
    eyesCapture: async (_model, detail) => { calls.push(["capture", detail]); return frame("screen", detail, ++now); },
    eyesStop: async source => { stopped.push(source); return { ok: true }; },
  };
  let cameraStopped = 0;
  const camera = { capture: detail => frame("camera", detail, ++now), stop: () => { cameraStopped++; } };
  const controller = new Controller({ bridge, cameraFactory: async () => camera, clock: () => now,
    setTimer: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimer: id => timers.delete(id) });
  return { bridge, calls, stopped, controller, timers, camera, get now() { return now; }, set now(value) { now = value; },
    get cameraStopped() { return cameraStopped; }, async fire() { const jobs = [...timers.values()]; timers.clear(); await Promise.all(jobs.map(fn => fn())); } };
}

test("KAI Eyes keeps six low-resolution frames, returns only the freshest turn context and keeps look ephemeral", async () => {
  const f = rendererFixture();
  assert.deepEqual(f.controller.snapshot(), { available: true, active: false, sources: [] });
  await f.controller.enable("screen", "seer");
  assert.equal(f.controller.snapshot().active, true);
  for (let i = 0; i < 8; i++) await f.fire();
  assert.equal(f.controller.states.screen.frames.length, 6, "rolling memory is bounded");
  const latest = f.controller.states.screen.frames.at(-1);
  const context = await f.controller.context("seer");
  assert.equal(context.length, 1);
  assert.equal(context[0].dataUrl, latest.dataUrl);
  const before = f.controller.states.screen.frames.length;
  const close = await f.controller.look("screen", "seer");
  assert.equal(close.detail, "look");
  assert.equal(f.controller.states.screen.frames.length, before, "high-detail look never enters the rolling buffer");
  assert.ok(f.calls.some(call => call[0] === "validate"));
});

test("camera tracks and every buffered frame are discarded on Off/hide", async () => {
  const f = rendererFixture();
  await f.controller.enable("camera", "seer");
  assert.equal(f.controller.states.camera.frames.length, 1);
  await f.controller.stopAll();
  assert.equal(f.cameraStopped, 1);
  assert.equal(f.controller.states.camera.frames.length, 0);
  assert.equal(f.controller.snapshot().active, false);
  assert.deepEqual(await f.controller.context("seer"), []);
  assert.ok(f.stopped.includes("camera"));
});

test("late grants and frames cannot revive a source after Stop or a model change", async () => {
  const f = rendererFixture();
  let allow;
  f.bridge.eyesEnable = () => new Promise(resolve => { allow = resolve; });
  const pending = f.controller.enable("screen", "seer");
  await tick();
  await f.controller.disable("screen");
  allow({ enabled: true, source: "screen", model: "seer", destination: "local", label: "Seer" });
  await pending;
  assert.equal(f.controller.snapshot().active, false);
  assert.ok(f.stopped.includes("screen"), "late main-process grant is explicitly retired");

  f.bridge.eyesEnable = async (source, model) => ({ enabled: true, source, model, destination: "local", label: model });
  await f.controller.enable("screen", "seer");
  await assert.rejects(() => f.controller.context("different"), /selected brain changed/i);
  assert.equal(f.controller.snapshot().active, false);
});

test("only bounded image data URLs enter a visual turn", () => {
  assert.equal(validFrame(frame("screen", "context", 1), "screen", "context"), true);
  assert.equal(validFrame({ ...frame("screen", "context", 1), dataUrl: "https://example.com/a.jpg" }, "screen", "context"), false);
  assert.equal(validFrame({ ...frame("camera", "context", 1), source: "screen" }, "camera", "context"), false);
  assert.deepEqual(fitSize(1080, 1920, 1600), { width: 900, height: 1600 }, "portrait camera frames bound their longest edge");
});

function mainFixture({ kind = "local", vision = true, label = "Seer", approve = true } = {}) {
  let visible = true, now = 5000, captureOptions, dialogOptions;
  const window = { isDestroyed: () => false, isVisible: () => visible, getBounds: () => ({ x: 100, y: 80, width: 660, height: 560 }) };
  const thumb = { isEmpty: () => false, toJPEG: quality => { assert.ok(quality >= 50 && quality <= 90); return Buffer.from("jpeg bytes"); }, getSize: () => ({ width: 640, height: 360 }) };
  const service = new MascotEyes({
    desktopCapturer: { getSources: async options => { captureOptions = options; return [{ display_id: "7", thumbnail: thumb }]; } },
    screen: { getDisplayNearestPoint: () => ({ id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    dialog: { showMessageBox: async (_window, options) => { dialogOptions = options; return { response: approve ? 1 : 0 }; } },
    getWindow: () => window, describeModel: async () => ({ kind, vision, label }), now: () => ++now,
  });
  return { service, window, get visible() { return visible; }, set visible(value) { visible = value; },
    get captureOptions() { return captureOptions; }, get dialogOptions() { return dialogOptions; } };
}

test("main-process grants are explicit, model-bound and capture only the companion display", async () => {
  const f = mainFixture();
  const grant = await f.service.enable("screen", "seer");
  assert.equal(grant.enabled, true);
  assert.match(f.dialogOptions.detail, /Frames stay on this computer/);
  const image = await f.service.capture("seer", "context");
  assert.equal(image.source, "screen");
  assert.match(image.dataUrl, /^data:image\/jpeg;base64,/);
  assert.deepEqual(f.captureOptions.types, ["screen"]);
  assert.deepEqual(f.captureOptions.thumbnailSize, { width: 640, height: 360 });
  await assert.rejects(() => f.service.capture("another", "context"), /permission ended/i);
  f.service.stop();
  await assert.rejects(() => f.service.validate("screen", "seer"), /permission ended/i);
});

test("screen capture bounds portrait displays and fails closed when KAI's display is not identifiable", async () => {
  const portrait = mainFixture();
  portrait.service.screen.getDisplayNearestPoint = () => ({ id: 7, bounds: { x: 0, y: 0, width: 1080, height: 1920 } });
  await portrait.service.enable("screen", "seer");
  await portrait.service.capture("seer", "look");
  assert.deepEqual(portrait.captureOptions.thumbnailSize, { width: 900, height: 1600 });

  portrait.service.desktopCapturer.getSources = async () => [{ display_id: "other", thumbnail: {} }];
  await assert.rejects(() => portrait.service.capture("seer", "context"), /could not identify the screen/i);
});

test("KAI Eyes rejects network/text-only models and names private egress before capture", async () => {
  const blind = mainFixture({ vision: false });
  await assert.rejects(() => blind.service.enable("camera", "text-model"), /cannot see images/i);
  await assert.rejects(() => blind.service.enable("screen", "koinos-network"), /installed local vision model/i);

  const privateModel = mainFixture({ kind: "private", label: "OpenAI" });
  await privateModel.service.enable("camera", "desktop:openai:gpt-5");
  assert.match(privateModel.dialogOptions.detail, /sent directly to your private OpenAI API connection/i);
  privateModel.visible = false;
  await assert.rejects(() => privateModel.service.validate("camera", "desktop:openai:gpt-5"), /hidden/i);
  assert.equal(privateModel.service.grants.size, 0);
});
