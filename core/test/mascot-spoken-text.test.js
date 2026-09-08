"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { speechText, SpeechPhrases } = require("../../ui/mascot-client");

test("Spoken answers keep facts and descriptive labels but omit URLs and citation clutter", () => {
  const reply = "Tomorrow is 22.5 degrees. [1](https://weather.example/forecast?q=Paris&day=2) " +
    "The [hourly forecast](https://weather.example/hour_(local)/today) shows rain at 4 p.m. " +
    "Bring a coat [2, 3].\nSources: https://weather.example/forecast\n" +
    "[weather]: https://weather.example/today\nStay dry!";
  assert.equal(speechText(reply), "Tomorrow is 22.5 degrees. The hourly forecast shows rain at 4 p.m. Bring a coat. Stay dry!");
  for (const url of ["https://example.com/a?b=2#section", "http://example.com:8000/a", "www.example.com/test", "tubi.tv", "weather.co.uk/forecast", "<https://example.com>"]) {
    assert.equal(speechText("Ready. " + url + " Have fun!"), "Ready. Have fun!", url);
  }
  assert.equal(speechText("Rain tomorrow (Source: [Weather](https://example.com))."), "Rain tomorrow.");
  assert.equal(speechText("[Useful details][weather]."), "Useful details.");
  assert.equal(speechText("https://example.com."), "");
  assert.equal(speechText("3.14, version 1.2.3, 4 p.m., Dr. Kim, $12.50 and 42 KAI."), "3.14, version 1.2.3, 4 p.m., Dr. Kim, $12.50 and 42 KAI.");
});

test("Emoji names handle modifiers, keycaps and whole joined symbols without reading Unicode fragments", () => {
  assert.equal(speechText("Hello 😊! Great job 👍🏽. I am 🤖."), "Hello smiley face emoji! Great job thumbs up emoji. I am robot emoji.");
  assert.equal(speechText("❤️ ☺️ 👋🏿 1️⃣ #️⃣ *️⃣ 🇰🇷 👩🏽‍💻"), "heart emoji smiley face emoji waving hand emoji 1 keycap emoji hash keycap emoji asterisk keycap emoji flag emoji emoji");
  assert.equal(speechText("That is a smiley face emoji."), "That is a smiley face emoji.");
  assert.equal(speechText("안녕하세요 😊. 123 #1 *2"), "안녕하세요 smiley face emoji. 123 1 2");
});

test("Every stream split keeps URLs silent and emits emoji once without delaying the first useful sentence", () => {
  const reply = "Tomorrow will be sunny. 😊 Bring water. " +
    "[Forecast](https://weather.example/a_(local)?x=1&y=2). " +
    "https://weather.example/today. 👍🏽 Have fun!\nSources: https://weather.example/today";
  const expected = "Tomorrow will be sunny. smiley face emoji Bring water. Forecast. thumbs up emoji Have fun!";
  for (let split = 0; split <= reply.length; split++) {
    const stream = new SpeechPhrases();
    const parts = [...stream.push(reply.slice(0, split)), ...stream.push(reply), ...stream.push(reply, true)];
    assert.equal(parts.join(" "), expected, "split " + split);
    assert.deepEqual(stream.push(reply, true), []);
  }
  const stream = new SpeechPhrases(), parts = [];
  for (let i = 1; i <= reply.length; i++) parts.push(...stream.push(reply.slice(0, i)));
  parts.push(...stream.push(reply, true)); assert.equal(parts.join(" "), expected);
  assert.deepEqual(new SpeechPhrases().push("Tomorrow will be sunny. The forecast is still"), ["Tomorrow will be sunny."]);
  assert.deepEqual(new SpeechPhrases().push("Read [the forecast](https://example.com/a_(unfinished", true), ["Read the forecast"]);
});
