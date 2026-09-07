"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { folderRequest, wakeRequest, SpeechPhrases } = require("../../ui/mascot-client");
const { createFolderActions } = require("../../electron/desktop-actions");
const { Activity, Listener, isEcho } = require("../../ui/mascot-wake");
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

test("Local activity catches quiet speech sooner, keeps the onset and bounds continuous capture", () => {
  const a = new Activity(16000), silence = new Float32Array(1600), speech = new Float32Array(1600).fill(.009);
  for (let i = 0; i < 100; i++) assert.equal(a.push(silence), null);
  assert.ok(a.pre.length <= 3);
  for (let i = 0; i < 4; i++) assert.equal(a.push(speech), null);
  let output; for (let i = 0; i < 5; i++) output = a.push(silence) || output;
  assert.ok(output instanceof Float32Array); assert.ok(output.some(v => v > .008));
  assert.ok(output.length <= 16000 * 1.3);
  let bounded; for (let i = 0; i < 200; i++) bounded = a.push(new Float32Array(1600).fill(i % 10 < 5 ? .009 : .025)) || bounded;
  assert.ok(bounded.length <= 16000 * 20);
});

function listening(options = {}) {
  const listener = new Listener({ transcribe: async () => ({ text: "" }), wakeRequest,
    onCommand() {}, onState() {}, onError: assert.fail, ...options });
  listener.active = true; listener.context = { sampleRate: 16000, close: async () => {} };
  listener.activity = new Activity(16000);
  for (let i = 0; i < 6; i++) listener.frame(new Float32Array(1600));
  return listener;
}
function utterance(listener) {
  let job;
  for (let i = 0; i < 4; i++) job = listener.frame(new Float32Array(1600).fill(.03)) || job;
  for (let i = 0; i < 5; i++) job = listener.frame(new Float32Array(1600)) || job;
  return job;
}

test("Wake recognition discards ambient speech and keeps a conversation open for follow-ups", async t => {
  for (const text of ["I was talking about Kai.", "hey kayak bring up pictures", "my friend said hey Kai", "Heikaido is a place", "heykaiju"]) assert.equal(wakeRequest(text), null);
  for (const prefix of ["Hey, Kay!", "Hi KAI,", "Hey Kye", "Hey K. A. I.", "Heikai.", "HeyKai,"]) {
    assert.deepEqual(wakeRequest(prefix + " Open my Pictures folder."), { text: "Open my Pictures folder." });
  }
  let transcript = "ordinary private conversation", calls = [], states = [];
  const listener = listening({ transcribe: async () => ({ text: transcript }),
    onCommand: text => calls.push(text), onState: state => states.push(state) });
  t.after(() => listener.stop());
  await utterance(listener); assert.deepEqual(calls, []);
  transcript = "Hey KAI"; await utterance(listener); assert.equal(states.at(-1), "listening");
  transcript = "What time is it?"; await utterance(listener);
  transcript = "What about tomorrow?"; await utterance(listener);
  assert.deepEqual(calls, ["What time is it?", "What about tomorrow?"]);
  transcript = "That's all."; await utterance(listener); assert.equal(listener.engaged, false);
  transcript = "another private conversation"; await utterance(listener); assert.equal(calls.length, 2);
  transcript = "Hey KAI, open pictures."; await utterance(listener); assert.equal(calls.at(-1), "open pictures.");
});

test("Capture continues during transcription, including a question immediately after the wake phrase", async t => {
  const pending = [], calls = [];
  const listener = listening({ transcribe: () => new Promise(resolve => pending.push(resolve)), onCommand: text => calls.push(text) });
  t.after(() => listener.stop());
  const first = utterance(listener);
  utterance(listener); // Still recording even though the wake ASR has not returned.
  assert.equal(pending.length, 1); assert.equal(listener.queue.length, 1);
  pending.shift()({ text: "Hey Kai" }); await tick();
  assert.equal(pending.length, 1);
  pending.shift()({ text: "Bring up my pictures folder." }); await first;
  assert.deepEqual(calls, ["Bring up my pictures folder."]);
  const late = utterance(listener); await listener.stop();
  pending.shift()({ text: "Hey Kai open downloads" }); await late;
  assert.equal(calls.length, 1); assert.equal(listener.phase, "off");
});

test("Speech onset pauses a reply before ASR; speaker echo resumes it without a new question", async t => {
  const pending = [], calls = [], events = [];
  const listener = listening({ transcribe: () => new Promise(resolve => pending.push(resolve)),
    onCommand: text => calls.push(text), onInterrupt: () => events.push("pause"), onResume: () => events.push("resume") });
  t.after(() => listener.stop());
  listener.engage(); listener.setResponding(true); listener.setPlayback(true); listener.hearOutput("Here is how to organize your pictures into albums.");
  const echo = utterance(listener);
  assert.equal(events[0], "pause"); assert.equal(calls.length, 0);
  pending.shift()({ text: "organize your pictures into albums" }); await echo;
  assert.deepEqual(calls, []); assert.equal(events.at(-1), "resume");
  const interruption = utterance(listener); assert.equal(events.at(-1), "pause");
  pending.shift()({ text: "Actually, tell me about my music instead." }); await interruption;
  assert.deepEqual(calls, ["Actually, tell me about my music instead."]);
  assert.equal(isEcho("Yes", "Yes, I can help you"), false);
});

test("Follow-up timeout starts after the reply, and Stop listening releases the session", async t => {
  let text = "Stop listening", ended;
  const listener = listening({ followUpMs: 20, transcribe: async () => ({ text }), onEnd: off => { ended = off; } });
  t.after(() => listener.stop());
  listener.engage(); listener.setResponding(true);
  await new Promise(r => setTimeout(r, 45)); assert.equal(listener.engaged, true);
  listener.setResponding(false);
  await new Promise(r => setTimeout(r, 45)); assert.equal(listener.engaged, false);
  assert.equal(listener.active, true, "Idle timeout returns to wake-only listening");
  listener.engage(); await utterance(listener);
  assert.equal(listener.active, false); assert.equal(ended, true);
});

test("Holding playback does not start another phrase; releasing continues the queue exactly once", async () => {
  const played = [], ends = [], held = [];
  const q = new Queue({ prepare: async text => text, play: text => { played.push(text); return new Promise(r => ends.push(r)); },
    cancel: () => ends.splice(0).forEach(r => r()), holdPlayback: value => held.push(value), onState() {}, onError: assert.fail });
  q.enqueue(["One.", "Two."]); await tick(); await tick();
  q.hold(true); ends.shift()(); await tick();
  assert.deepEqual(played, ["One."]);
  q.hold(false); await tick(); assert.deepEqual(played, ["One.", "Two."]);
  assert.deepEqual(held, [true, false]); q.stop();
});


test("Off during asynchronous microphone startup cannot reacquire capture afterwards", async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let acquisitions = 0, release;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {
    getUserMedia: async () => { acquisitions++; throw new Error("Should not acquire"); },
  } } });
  t.after(() => { if (prior) Object.defineProperty(globalThis, "navigator", prior); else delete globalThis.navigator; });
  const listener = listening();
  listener.context.close = () => new Promise(resolve => { release = resolve; });
  const start = listener.start();
  await listener.stop(); release(); await start;
  assert.equal(acquisitions, 0); assert.equal(listener.active, false);
});

test("Room calibration rejects a loud steady fan, still captures speech, and adapts to a new hum", () => {
  const a = new Activity(16000), fan = new Float32Array(1600).fill(.02);
  for (let i = 0; i < 100; i++) assert.equal(a.push(fan), null);
  assert.equal(a.voiced, 0); assert.equal(a.frames.length, 0);
  for (let i = 0; i < 4; i++) a.push(new Float32Array(1600).fill(.06));
  let output; for (let i = 0; i < 6; i++) output = a.push(fan) || output;
  assert.ok(output?.some(v => v > .05), "Speech above the room noise still has an endpoint");
  const hum = new Float32Array(1600).fill(.045);
  for (let i = 0; i < 400; i++) assert.equal(a.push(hum), null, "Sustained hum never becomes 20-second Whisper requests");
  assert.equal(a.frames.length, 0);
});

test("A rejected interruption releases its own hold while a second sound is still arriving", async t => {
  const pending = [], events = [];
  const listener = listening({ transcribe: () => new Promise(resolve => pending.push(resolve)),
    onInterrupt: () => events.push("pause"), onResume: () => events.push("resume") });
  t.after(() => listener.stop());
  listener.engage(); listener.setResponding(true); listener.setPlayback(true);
  const first = utterance(listener);
  for (let i = 0; i < 4; i++) listener.frame(new Float32Array(1600).fill(.03));
  assert.equal(listener.segment.started, true);
  assert.deepEqual(events, ["pause"], "The second sound cannot steal the first hold");
  pending.shift()({ text: "" }); await first;
  assert.deepEqual(events, ["pause", "resume"]);
  assert.equal(listener.active, true); assert.equal(listener.segment.started, true);
});

test("Preparing a slow voice cannot be held by background activity; late playback overlap is echo", async t => {
  const calls = [], events = [];
  const listener = listening({ transcribe: async () => ({ text: "Of course" }), onCommand: text => calls.push(text),
    onInterrupt: () => events.push("pause") });
  t.after(() => listener.stop()); listener.engage(); listener.setResponding(true);
  for (let i = 0; i < 3; i++) listener.frame(new Float32Array(1600).fill(.03));
  assert.deepEqual(events, []);
  listener.hearOutput("Of course. I can help you with that."); listener.setPlayback(true);
  let job; for (let i = 0; i < 6; i++) job = listener.frame(new Float32Array(1600)) || job;
  await job; assert.deepEqual(calls, [], "Output beginning mid-capture is never sent back as a user prompt");
});

test("A stalled recognition cannot hold playback forever or toggle microphone capture", async t => {
  const events = [], calls = []; let complete;
  const listener = listening({ interruptMs: 20, transcribe: () => new Promise(r => { complete = r; }),
    onCommand: text => calls.push(text), onInterrupt: () => events.push("pause"), onResume: () => events.push("resume") });
  t.after(() => listener.stop()); listener.engage(); listener.setResponding(true); listener.setPlayback(true);
  const job = utterance(listener);
  await new Promise(r => setTimeout(r, 35));
  assert.deepEqual(events, ["pause", "resume"]); assert.equal(listener.active, true);
  for (let i = 0; i < 3; i++) listener.frame(new Float32Array(1600).fill(.03));
  assert.deepEqual(events, ["pause", "resume"], "Repeated candidates cannot re-pause this reply after timeout");
  complete({ text: "Actually, change the subject." }); await job;
  assert.deepEqual(calls, ["Actually, change the subject."], "A late confirmed interruption is still accepted");
});

test("Transient recognition failures keep one microphone session; repeated failures stop once", async t => {
  let fail = true; const errors = [], commands = [];
  const listener = listening({ transcribe: async () => { if (fail) throw new Error("Engine busy"); return { text: "Hello KAI" }; },
    onCommand: text => commands.push(text), onError: (error, options) => errors.push({ error, options }) });
  t.after(() => listener.stop()); listener.engage();
  await utterance(listener); assert.equal(listener.active, true); assert.equal(errors[0].options.recoverable, true);
  fail = false; await utterance(listener); assert.deepEqual(commands, ["Hello KAI"]);
  fail = true;
  await utterance(listener); await utterance(listener); assert.equal(listener.active, true);
  await utterance(listener); assert.equal(listener.active, false); assert.match(errors.at(-1).error.message, /microphone is off/);
});

test("A hung transcription is aborted and returns to listening without reacquiring the device", async t => {
  let signal; const errors = [];
  const listener = listening({ transcribeMs: 20, transcribe: (audio, rate, abort) => { signal = abort; return new Promise(() => {}); },
    onError: (error, options) => errors.push({ error, options }) });
  t.after(() => listener.stop()); listener.engage();
  await utterance(listener);
  assert.equal(signal.aborted, true); assert.equal(listener.processing, false); assert.equal(listener.active, true);
  assert.equal(errors[0].error.code, "VOICE_TIMEOUT"); assert.equal(errors[0].options.recoverable, true);
});
