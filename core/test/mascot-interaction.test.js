"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { folderRequest, wakeRequest, SpeechPhrases } = require("../../ui/mascot-client");
const { createFolderActions } = require("../../electron/desktop-actions");
const { Activity, Listener } = require("../../ui/mascot-wake");
const { Queue } = require("../../ui/mascot-speech");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("Folder requests only recognize a complete user command, never quoted, compound or arbitrary paths", () => {
  for (const text of ["Bring up my Pictures folder.", "Can you open my photos?", "Please take me to Downloads", "open my pictures folder please"]) {
    assert.ok(folderRequest(text), text);
  }
  for (const text of ["How do I open my Pictures folder?", "Don't open my pictures", "'open my pictures'", "open my pictures and delete them",
    "open C:\\Windows", "open https://example.com", "Someone said open my pictures", "open my pictures/../secret"]) {
    assert.equal(folderRequest(text), null, text);
  }
});

test("Folder execution waits for native approval; deny, hide and invalid paths never open", async () => {
  let visible = true, approve, prompts = [], opened = [];
  const win = { isDestroyed: () => false, isVisible: () => visible };
  const actions = createFolderActions({
    app: { getPath: name => "/Users/test/" + name },
    dialog: { showMessageBox: (_win, options) => { prompts.push(options); return new Promise(resolve => { approve = resolve; }); } },
    shell: { openPath: async path => { opened.push(path); return ""; } },
  });
  let request = actions.open(win, "pictures");
  assert.deepEqual(opened, []); assert.equal(prompts[0].defaultId, 0);
  await assert.rejects(actions.open(win, "documents"), /current approval/);
  approve({ response: 0 }); assert.equal((await request).status, "cancelled");
  request = actions.open(win, "pictures"); actions.cancel(); approve({ response: 1 });
  assert.equal((await request).status, "cancelled");
  request = actions.open(win, "pictures"); visible = false; approve({ response: 1 });
  assert.equal((await request).status, "cancelled");
  visible = true;
  await assert.rejects(actions.open(win, "/tmp/unsafe"), /supported/);
  await assert.rejects(actions.open(win, "constructor"), /supported/);
  assert.deepEqual(opened, []);
  request = actions.open(win, "pictures"); approve({ response: 1 });
  assert.equal((await request).status, "opened"); assert.deepEqual(opened, ["/Users/test/pictures"]);
});

test("Speech starts before the response ends, preserves decimals and handles split code and reasoning without repetition", () => {
  const p = new SpeechPhrases();
  assert.deepEqual(p.push("Hello friend. Here's"), ["Hello friend."]);
  assert.deepEqual(p.push("Hello friend. Here's a number: 3."), []);
  assert.deepEqual(p.push("Hello friend. Here's a number: 3.14. Next"), ["Here's a number: 3.14."]);
  const text = "Hello friend. Here's a number: 3.14. Next is code.\n\x60\x60\x60js\nsecret();\n\x60\x60\x60\n<think>private reasoning.</think>All done!";
  let emitted = [];
  for (let i = 53; i <= text.length; i++) emitted.push(...p.push(text.slice(0, i)));
  emitted.push(...p.push(text, true));
  const spoken = emitted.join(" ");
  assert.equal(spoken, "Next is code. Code is shown in the chat. All done!");
  assert.deepEqual(p.push(text, true), []);
  const link = new SpeechPhrases();
  assert.deepEqual(link.push("Read [this. "), []);
  assert.deepEqual(link.push("Read [this. page](https://example.com). Okay"), ["Read this. page."]);
});

test("Speech queue prefetches while playing and discards an inference that completes after Stop", async () => {
  const pending = [], played = [], ends = [], states = [];
  let cancels = 0;
  const q = new Queue({
    prepare: text => new Promise(resolve => pending.push({ text, resolve })),
    play: text => { played.push(text); return new Promise(resolve => ends.push(resolve)); },
    cancel: () => { cancels++; ends.splice(0).forEach(end => end()); },
    onState: value => states.push(value), onError: error => assert.fail(error),
  });
  q.enqueue(["One.", "Two."]); await tick();
  assert.equal(pending.length, 1); pending[0].resolve("One."); await tick(); await tick();
  assert.deepEqual(played, ["One."]); assert.equal(pending[1].text, "Two.");
  q.stop(); pending[1].resolve("Two."); await tick();
  assert.deepEqual(played, ["One."]); assert.equal(cancels, 1); assert.equal(states.at(-1), "idle");
  q.enqueue(["Fresh."]); await tick(); pending[2].resolve("Fresh."); await tick();
  assert.deepEqual(played, ["One.", "Fresh."]); ends[0](); await tick();
  assert.equal(states.at(-1), "idle");
});

test("Local voice activity ignores silence, includes speech onset and bounds continuous capture", () => {
  const a = new Activity(16000), silence = new Float32Array(1600), speech = new Float32Array(1600).fill(.08);
  for (let i = 0; i < 100; i++) assert.equal(a.push(silence), null);
  assert.ok(a.pre.length <= 3);
  for (let i = 0; i < 5; i++) assert.equal(a.push(speech), null);
  let output; for (let i = 0; i < 9; i++) output = a.push(silence);
  assert.ok(output instanceof Float32Array); assert.ok(output.some(v => v > .07));
  assert.ok(output.length <= 16000 * 2);
  let bounded; for (let i = 0; i < 120; i++) bounded = a.push(speech) || bounded;
  assert.ok(bounded.length <= 16000 * 12);
});

test("Wake recognition discards ambient speech, accepts same-phrase and follow-up questions, and ignores late work after Off", async () => {
  assert.equal(wakeRequest("I was talking about Kai."), null);
  assert.equal(wakeRequest("hey kayak bring up pictures"), null);
  assert.deepEqual(wakeRequest("Hey, Kay! Open my Pictures folder."), { text: "Open my Pictures folder." });
  let transcript = "ordinary private conversation", calls = [], states = [], resolve;
  const listener = new Listener({
    transcribe: async () => transcript === "slow" ? new Promise(r => { resolve = r; }) : { text: transcript },
    wakeRequest, onCommand: async text => calls.push(text), onState: value => states.push(value), onError: assert.fail,
  });
  listener.active = true; listener.context = { sampleRate: 16000, close: async () => {} };
  listener.activity = { push: () => new Float32Array(1600), reset() {} };
  await listener.frame(null, 0); assert.deepEqual(calls, []);
  transcript = "Hey KAI"; await listener.frame(null, 0); assert.equal(states.at(-1), "listening");
  transcript = "What time is it?"; await listener.frame(null, 0); assert.deepEqual(calls, ["What time is it?"]);
  transcript = "Hey KAI, open my pictures folder."; await listener.frame(null, 0);
  assert.equal(calls.at(-1), "open my pictures folder.");
  listener.pause(true); transcript = "Hey KAI, repeat yourself."; await listener.frame(null, 0);
  assert.equal(calls.length, 2);
  listener.pause(false); listener.resumeAt = 0; transcript = "slow";
  const late = listener.frame(null, 0); await listener.stop(); resolve({ text: "Hey KAI open downloads" }); await late;
  assert.equal(calls.length, 2); assert.equal(states.at(-1), "off");
});
