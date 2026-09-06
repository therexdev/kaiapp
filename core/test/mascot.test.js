"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { fitBounds, trustedFrame } = require("../../electron/mascot");
const { chooseModel, messagesFor, completion, speechText } = require("../../ui/mascot-client");

test("KAI stays on the usable desktop across expansion, removed screens and negative monitor coordinates", () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1040 };
  const compact = fitBounds({ x: -24, y: 1024 }, false, area);
  const chat = fitBounds({ x: compact.x + compact.width, y: compact.y + compact.height }, true, area);
  assert.equal(chat.x + chat.width, compact.x + compact.width);
  assert.equal(chat.y + chat.height, compact.y + compact.height);
  const removed = fitBounds({ x: -9000, y: 8000 }, true, { x: 0, y: 0, width: 1280, height: 720 });
  assert.deepEqual(removed, { x: 0, y: 160, width: 660, height: 560 });
  assert.deepEqual(fitBounds({ x: 10, y: 10 }, true, { x: 0, y: 0, width: 600, height: 500 }), { x: 0, y: 0, width: 600, height: 500 });
});

test("Desktop window controls refuse other renderers, subframes and foreign origins", () => {
  const origin = "http://127.0.0.1:41100", frame = { url: origin + "/mascot.html" };
  const contents = { mainFrame: frame }, win = { isDestroyed: () => false, webContents: contents };
  assert.equal(trustedFrame({ sender: contents, senderFrame: frame }, win, origin), true);
  assert.equal(trustedFrame({ sender: {}, senderFrame: frame }, win, origin), false);
  assert.equal(trustedFrame({ sender: contents, senderFrame: { url: frame.url } }, win, origin), false);
  frame.url = "https://example.com/mascot.html";
  assert.equal(trustedFrame({ sender: contents, senderFrame: frame }, win, origin), false);
});

test("KAI reuses a ready model and only selects the network when explicitly requested", () => {
  const models = [{ alias: "ready", status: "ready" }, { alias: "missing", status: "missing" }];
  assert.equal(chooseModel(models, "ready", "missing", "old"), "ready");
  assert.equal(chooseModel([], null, null, "koinos-network"), "");
  assert.equal(chooseModel(models, "ready", "koinos-network:small", null), "koinos-network:small");
});

test("Long conversations retain recent complete turns without losing the current question", () => {
  const history = [];
  for (let i = 0; i < 20; i++) history.push({ role: "user", content: "Q" + i + "x".repeat(300) }, { role: "assistant", content: "A" + i + "x".repeat(300) });
  history.push({ role: "user", content: "What did I just ask?" });
  const messages = messagesFor(history);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.deepEqual(messages.at(-1), history.at(-1));
  assert.ok(messages.length < history.length);
});

test("Streaming replies survive split UTF-8, CRLF and a final frame without a newline", async () => {
  const raw = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello 🤖"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" KAI"}}]}\n\ndata: [DONE]');
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of raw) controller.enqueue(Uint8Array.of(byte)); controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
  let answer = "";
  for await (const delta of completion(response)) answer += delta.content;
  assert.equal(answer, "Hello 🤖 KAI");
});

test("KAI reports an interrupted stream and upstream errors instead of silently saving a complete-looking reply", async () => {
  const collect = async response => { for await (const _delta of completion(response)) { /* drain */ } };
  await assert.rejects(() => collect(new Response('data: {"choices":[{"delta":{"content":"Half"}}]}\n\n')), /before KAI finished/);
  await assert.rejects(() => collect(new Response('data: {"error":{"message":"Model is busy"}}\n\n')), /Model is busy/);
  await assert.rejects(() => collect(new Response('{"error":{"message":"No model ready"}}', { status: 503 })), /No model ready/);
});

test("Spoken replies strip formatting and explain code instead of reading its syntax", () => {
  assert.equal(speechText("## Hello **friend**. [Read more](https://example.com).\n" + "\x60\x60\x60js\nsecret()\n\x60\x60\x60"), "Hello friend. Read more. Code is shown in the chat.");
});
