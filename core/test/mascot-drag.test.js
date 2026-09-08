"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { dragPlacement, PERCH_LIFT } = require("../../electron/mascot-layout");
const { createMascotController } = require("../../electron/mascot");
const area = { x: -1920, y: -1080, width: 1920, height: 1040 };
const inside = (b, a) => {
  assert.ok(b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height, JSON.stringify({ b, a }));
};
test("Dragging uses unclamped intent while keeping compact and expanded windows inside any work area", () => {
  for (const expanded of [false, true]) for (const work of [area, { x: 0, y: 0, width: 1280, height: 720 }, { x: 0, y: 1080, width: 800, height: 540 }]) {
    const start = { anchor: { x: work.x + 700, y: work.y + work.height - 100 }, cursor: { x: work.x + 500, y: work.y + 300 }, perched: false };
    const out = dragPlacement(start, { x: work.x + 100, y: work.y + work.height }, expanded, work);
    inside(out.bounds, work); assert.equal(out.perched, true);
    assert.ok(out.anchor.y > work.y + work.height, "OS clamping never replaces the intended anchor");
    const back = dragPlacement(start, start.cursor, expanded, work);
    inside(back.bounds, work); assert.equal(back.perched, false);
    assert.equal(back.anchor.y, start.anchor.y, "Returning the hand restores its original height");
  }
});
test("Perched KAI slides along the edge, resists tiny vertical jitter and lifts continuously under the hand", () => {
  const start = { anchor: { x: -100, y: -40 }, cursor: { x: -220, y: -150 }, perched: true };
  const slide = dragPlacement(start, { x: -620, y: -170 }, false, area);
  assert.equal(slide.lifted, false); assert.equal(slide.perched, true);
  assert.equal(slide.bounds.x + slide.bounds.width, -500); assert.equal(slide.bounds.y + slide.bounds.height, -40);
  const lift = dragPlacement(start, { x: -220, y: -190 }, false, area);
  assert.equal(lift.lifted, true); assert.equal(lift.offsetY, PERCH_LIFT - 40);
  assert.equal(lift.bounds.y + lift.bounds.height + lift.offsetY, start.anchor.y + PERCH_LIFT - 40, "Visual free-body origin stays under the lifted head");
  const free = dragPlacement({ ...start, lifted: true }, { x: -220, y: -350 }, false, area);
  assert.equal(free.perched, false); assert.equal(free.offsetY, 0); inside(free.bounds, area);
  const returnToEdge = dragPlacement({ ...start, lifted: true }, start.cursor, false, area);
  assert.equal(returnToEdge.perched, true);
});
function nativeFixture(t, saved) {
  const ipcMain = new EventEmitter(); ipcMain.handles = new Map();
  ipcMain.handle = (key, fn) => ipcMain.handles.set(key, fn); ipcMain.removeHandler = key => ipcMain.handles.delete(key);
  const screen = new EventEmitter(); let cursor = { x: -600, y: -400 }, work = area, tick;
  screen.getCursorScreenPoint = () => cursor;
  screen.getDisplayNearestPoint = point => { assert.ok(Number.isFinite(point.x)); return { workArea: work }; };
  screen.getDisplayMatching = () => { throw new Error("Window intersection must not choose the drag monitor"); };
  t.mock.method(global, "setInterval", fn => { tick = fn; return { unref() {} }; });
  t.mock.method(global, "clearInterval", () => {});
  class Window extends EventEmitter {
    constructor(options) { super(); this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height }; this.visible = false; this.events = []; this.shapes = [];
      this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: "http://localhost:7777/mascot.html" };
      this.webContents.send = (_name, value) => this.events.push(value); this.webContents.setWindowOpenHandler = () => {};
    }
    isDestroyed() { return !!this.destroyed; } isVisible() { return this.visible; }
    getBounds() { return { ...this.bounds }; } setBounds(b) { inside(b, work); this.bounds = { ...b }; }
    setIgnoreMouseEvents() {} setShape(shape) { this.shapes.push(shape); }
    async loadURL() {} show() { this.visible = true; this.emit("show"); } hide() { this.visible = false; this.emit("hide"); }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  let stored = saved;
  const controller = createMascotController({ BrowserWindow: Window, screen, ipcMain, shell: {}, origin: "http://localhost:7777",
    prefs: { get: () => stored, set: (_key, value) => { stored = value; } }, getMainWindow: () => null });
  const event = () => ({ sender: controller.getWindow().webContents, senderFrame: controller.getWindow().webContents.mainFrame });
  const emit = (name, ...args) => ipcMain.emit("mascot:" + name, event(), ...args);
  t.after(() => controller.dispose());
  return { controller, emit, ipcMain, event, screen, move(point) { cursor = point; }, setArea(a) { work = a; }, tick: () => tick(), stored: () => stored,
    pose: () => controller.getWindow().events.filter(e => e.type === "placement").at(-1).value };
}
test("Native drag samples release position, remembers the edge, preserves expansion and cancels cleanly", async t => {
  const f = nativeFixture(t); await f.controller.launch();
  const win = f.controller.getWindow(); f.emit("regions", [{ x: 10, y: 10, width: 150, height: 200 }]);
  f.emit("drag-start"); assert.equal(f.pose().pose, "carried"); assert.deepEqual(win.shapes.at(-1), []);
  f.move({ x: -800, y: -30 }); f.emit("drag-end"); // No timer tick: mouseup itself samples the last position.
  assert.equal(f.pose().pose, "perched"); assert.equal(f.pose().landed, true);
  assert.equal(win.bounds.y + win.bounds.height, -40); assert.equal(f.stored().perched, true);
  const right = win.bounds.x + win.bounds.width;
  await f.ipcMain.handles.get("mascot:expand")(f.event(), true);
  assert.equal(win.bounds.y + win.bounds.height, -40); assert.equal(win.bounds.x + win.bounds.width, right);
  f.emit("drag-start"); f.move({ x: -900, y: -230 }); f.tick();
  assert.equal(f.pose().pose, "carried");
  win.emit("blur"); assert.equal(f.pose().pose, "free"); assert.equal(f.pose().cancelled, true);
  const stopped = win.getBounds(); f.move({ x: -500, y: -900 }); f.tick(); assert.deepEqual(win.getBounds(), stopped);
  f.emit("drag-start"); win.hide(); assert.equal(f.pose().pose, "free");
  await f.controller.launch(); assert.equal(win.bounds.width, 248); assert.equal(f.pose().pose, "free");
});
test("Drag rejects foreign frames and migrates to the cursor monitor even with negative or stacked displays", async t => {
  const f = nativeFixture(t, { x: -100, y: -40, perched: true }); await f.controller.launch();
  const win = f.controller.getWindow();
  f.ipcMain.emit("mascot:drag-start", { ...f.event(), senderFrame: { url: f.event().senderFrame.url } });
  assert.equal(f.pose().pose, "perched");
  f.emit("drag-start");
  const lower = { x: 0, y: 1080, width: 1280, height: 720 }; f.setArea(lower); f.move({ x: 600, y: 1770 }); f.tick(); f.emit("drag-end");
  inside(win.bounds, lower); assert.equal(win.bounds.y + win.bounds.height, 1800); assert.equal(f.stored().perched, true);
  f.setArea({ x: 0, y: 0, width: 1280, height: 720 }); f.screen.emit("display-removed");
  assert.equal(win.bounds.y + win.bounds.height, 720); assert.equal(f.pose().pose, "perched");
  win.destroy(); await f.controller.launch(); assert.equal(f.pose().pose, "perched");
});

test("Every desktop control IPC requires the exact companion document and main frame", async t => {
  const f = nativeFixture(t); await f.controller.launch();
  assert.equal(typeof f.ipcMain.handles.get("mascot:computer-status")(f.event()).available, "boolean");
  for (const channel of ["computer-status", "computer-begin", "computer-call", "computer-end", "open-website"]) {
    const call = f.ipcMain.handles.get("mascot:" + channel), e = f.event();
    assert.throws(() => call({ ...e, sender: {} }), /Untrusted/);
    assert.throws(() => call({ ...e, senderFrame: { url: e.senderFrame.url } }), /Untrusted/);
    e.senderFrame.url = "http://localhost:7777/another-document";
    assert.throws(() => call(e), /denied/);
    e.senderFrame.url = "http://localhost:7777/mascot.html";
  }
});

test("Pocket voice IPC requires the exact visible companion and releases native work on hide", async t => {
  const { PocketVoice } = require("../../electron/pocket-voice"); let calls = 0, releases = 0;
  t.mock.method(PocketVoice.prototype, "warm", async () => { calls++; });
  t.mock.method(PocketVoice.prototype, "generate", async () => { calls++; });
  t.mock.method(PocketVoice.prototype, "ensure", async () => { calls++; });
  t.mock.method(PocketVoice.prototype, "close", () => { releases++; });
  const f = nativeFixture(t); await f.controller.launch(); const win = f.controller.getWindow();
  for (const channel of ["status", "setup", "warm", "speech", "cancel", "release"]) {
    const invoke = f.ipcMain.handles.get("mascot:pocket-" + channel);
    assert.throws(() => invoke({ ...f.event(), sender: {} }), /Untrusted/);
    assert.throws(() => invoke({ ...f.event(), senderFrame: { url: f.event().senderFrame.url } }), /Untrusted/);
    win.webContents.mainFrame.url = "http://localhost:7777/";
    assert.throws(() => invoke(f.event()), /denied/);
    win.webContents.mainFrame.url = "http://localhost:7777/mascot.html";
  }
  assert.equal(calls, 0);
  await f.ipcMain.handles.get("mascot:pocket-warm")(f.event(), "alba"); assert.equal(calls, 1);
  win.hide(); assert.ok(releases > 0);
  for (const channel of ["setup", "warm", "speech"]) assert.throws(() => f.ipcMain.handles.get("mascot:pocket-" + channel)(f.event()), /hidden/);
  assert.equal(calls, 1);
});
