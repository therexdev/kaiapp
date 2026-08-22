"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

/*
 * v0.40.0 — the field report that produced this file:
 *
 *   "It did not make this file like it said the first time or the second."
 *
 * Asked to create calculator.html, the agent printed a write_file call as a
 * chat bubble, reported "done — 0 tool steps", never showed an approval card,
 * and on the next turn claimed the file already existed. Three separate
 * failures, each tested here:
 *
 *   1. the call did not parse (a hand-escaped HTML page never will), so the
 *      loop read it as prose and returned it as the answer;
 *   2. the nudge that exists for exactly this case ALSO parsed, so it agreed
 *      it was not a tool call and stayed quiet;
 *   3. nothing corrected the model when it narrated a write that never
 *      happened, so the lie entered the session history.
 */

const { salvageAction, parseAgentAction, stripFence } = require("../../ui/agents");
const { CodeAgent, looksLikeToolCall, answeredWithCode, claimsAWrite, truthfulAnswer } = require("../lib/code-agent");

const NAMES = ["list_files", "read_file", "search_files", "edit_file", "write_file", "run_cmd"];

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kai-salvage-"));
}

function scriptedChat(replies) {
  return async () => (replies.length ? replies.shift() : '{"answer": true}');
}

/* ------------------------------------------------------------- salvage --- */

test("salvage: the exact shape from the field report — fence, raw newlines, unescaped quotes", () => {
  const out = [
    '{"tool": "write_file", "args": {"path": "calculator.html", "content": "```html',
    "<!DOCTYPE html>",
    '<head><meta charset="UTF-8"><title>Calculator</title>',
    "<style>",
    ".btn { color: red; }",
    "</style></head>",
    '<body><div class="calc">0</div></body>',
    "</html>",
    '```"}}',
  ].join("\n");

  // Strict parsing cannot read this, and no prompt makes a 4B model escape a
  // whole web page by hand — which is precisely why salvage exists.
  assert.strictEqual(parseAgentAction(out, NAMES), null);

  const a = salvageAction(out, NAMES);
  assert.strictEqual(a.tool, "write_file");
  assert.strictEqual(a.args.path, "calculator.html");
  assert.ok(a.args.content.startsWith("<!DOCTYPE html>"), a.args.content.slice(0, 40));
  assert.ok(a.args.content.endsWith("</html>"));
  assert.ok(!a.args.content.includes("```"), "the markdown fence must not land in the file");
  // Braces INSIDE the content (a CSS rule) must survive: the tail is cut at
  // the closing quote, not at the first brace that looks like the end.
  assert.ok(a.args.content.includes(".btn { color: red; }"));
  assert.ok(a.args.content.includes('charset="UTF-8"'));
});

test("salvage: two long arguments in one call keep their own values", () => {
  const out = '{"tool":"edit_file","args":{"path":"a.js","find":"const a = 1;","replace":"const a = 2;\nconst b = "3";"}}';
  const a = salvageAction(out, NAMES);
  assert.deepStrictEqual(a, {
    tool: "edit_file",
    args: { path: "a.js", find: "const a = 1;", replace: 'const a = 2;\nconst b = "3";' },
  });
});

test("salvage: prose around the call, and \\n escapes that ARE correct", () => {
  const a = salvageAction('Sure! Here you go:\n{"tool":"write_file","args":{"path":"x.txt","content":"one\\ntwo"}}', NAMES);
  assert.strictEqual(a.args.content, "one\ntwo");
});

test("salvage refuses to guess: prose, and a tool that does not exist", () => {
  assert.strictEqual(salvageAction("A calculator needs HTML and CSS. I would start with the layout.", NAMES), null);
  assert.strictEqual(salvageAction('{"tool":"deploy_to_prod","args":{"path":"x"}}', NAMES), null);
  assert.strictEqual(salvageAction("", NAMES), null);
  // No tool name at all is not a tool call, however much JSON is present.
  assert.strictEqual(salvageAction('{"path":"a.txt","content":"hi"}', NAMES), null);
});

test("salvage does not swallow prose that runs on past the call", () => {
  // The action grammar has always been able to mistake an EXAMPLE for an
  // instruction; salvage must not make that worse by dragging the rest of the
  // sentence into the file. The last quote is the boundary.
  const t = 'A call looks like: {"tool": "write_file", "args": {"path": "x"}} — but I do not need one.';
  assert.deepStrictEqual(salvageAction(t, NAMES), { tool: "write_file", args: { path: "x" } });
});

test("stripFence only unwraps a fence that wraps the WHOLE value", () => {
  assert.strictEqual(stripFence("```js\nlet a = 1;\n```"), "let a = 1;");
  assert.strictEqual(stripFence("```\nplain\n```"), "plain");
  // A document that merely CONTAINS a fenced block keeps every character.
  const doc = "# Title\n\n```js\nlet a = 1;\n```\n\nAfter.";
  assert.strictEqual(stripFence(doc), doc);
  assert.strictEqual(stripFence("no fence here"), "no fence here");
});

/* ---------------------------------------------------------- the nudge ---- */

test("looksLikeToolCall sees an attempt even when the JSON is unparseable", () => {
  // The regression: this shape used to return false because the check parsed.
  assert.ok(looksLikeToolCall('{"tool": "write_file", "args": {"content": "<a href="x">"}}'));
  assert.ok(looksLikeToolCall('{"tool":"anything","args":{}}'));
  assert.ok(looksLikeToolCall('I will use {"name": "read_file"} now'));
  assert.ok(!looksLikeToolCall("Here is a plan: 1. read the file 2. change it"));
  assert.ok(!looksLikeToolCall("{ not json and no tool key }"));
  assert.ok(!looksLikeToolCall(""));
});

/* --------------------------------------------------- the false claim ----- */

test("claimsAWrite: catches the narrated write, leaves a plan alone", () => {
  assert.ok(claimsAWrite("I have already written the HTML code for you and placed it in a file named 'calculator.html'."));
  assert.ok(claimsAWrite("I created index.html with the layout."));
  assert.ok(claimsAWrite("I've saved the file for you."));
  // A plan describes what WOULD happen — correcting it would be the lie.
  assert.ok(!claimsAWrite("1. I would create calculator.html\n2. I would add the styles"));
  assert.ok(!claimsAWrite("The file already contains that markup, so nothing needs to change."));
  assert.ok(!claimsAWrite("A calculator needs a display and buttons."));
});

test("truthfulAnswer appends the correction only when nothing was written", () => {
  const lie = "I have written calculator.html for you.";
  assert.ok(truthfulAnswer(lie, false).includes("Nothing was written to disk"));
  assert.strictEqual(truthfulAnswer(lie, true), lie); // it really did write
  const plain = "The project has three files.";
  assert.strictEqual(truthfulAnswer(plain, false), plain);
});

/* --------------------------------------------------------- end to end --- */

test("end to end: the unparseable call now writes the file the person approved", async () => {
  const dir = tmpProject();
  const out = [
    '{"tool": "write_file", "args": {"path": "calculator.html", "content": "```html',
    '<html><body><div class="calc">0</div></body></html>',
    '```"}}',
  ].join("\n");
  const agent = new CodeAgent({ chatFn: scriptedChat([out, "Created the calculator."]) });
  const seen = [];
  const done = agent.run({
    dir,
    task: "make a calculator page",
    onTrace: (e) => {
      seen.push(e);
      if (e.type === "approval-request") agent.provideApproval(e.approvalId, true);
    },
  });
  const r = await done;
  assert.ok(seen.some((e) => e.type === "approval-request" && e.kind === "edit"), "an approval card must appear");
  assert.strictEqual(r.steps, 1, "one tool step, not zero");
  assert.strictEqual(r.wrote, true);
  const body = fs.readFileSync(path.join(dir, "calculator.html"), "utf8");
  assert.strictEqual(body, '<html><body><div class="calc">0</div></body></html>');
  assert.ok(!r.answer.includes("Nothing was written"), "it really wrote — do not correct it");
});

test("end to end: a claimed write with no write at all is corrected, not repeated", async () => {
  const dir = tmpProject();
  // The second turn of the field report: the model insists the file exists.
  const agent = new CodeAgent({
    chatFn: scriptedChat(["I have already written the HTML code and placed it in a file named calculator.html."]),
  });
  const r = await agent.run({ dir, task: "create it in the folder" });
  assert.strictEqual(r.wrote, false);
  assert.ok(r.answer.includes("Nothing was written to disk"));
  assert.ok(!fs.existsSync(path.join(dir, "calculator.html")));
});

test("end to end: declining the card leaves the disk untouched AND the claim corrected", async () => {
  const dir = tmpProject();
  const agent = new CodeAgent({
    chatFn: scriptedChat([
      '{"tool":"write_file","args":{"path":"a.txt","content":"hi"}}',
      "I saved a.txt for you.",
    ]),
  });
  const r = await agent.run({
    dir,
    task: "write a file",
    onTrace: (e) => {
      if (e.type === "approval-request") agent.provideApproval(e.approvalId, false);
    },
  });
  assert.strictEqual(r.wrote, false);
  assert.ok(!fs.existsSync(path.join(dir, "a.txt")));
  assert.ok(r.answer.includes("Nothing was written to disk"));
});

test("a markdown file keeps its fenced code block; other files do not keep the wrapper", async () => {
  const dir = tmpProject();
  const doc = "```md\n# Notes\n```";
  const agent = new CodeAgent({
    chatFn: scriptedChat([
      JSON.stringify({ tool: "write_file", args: { path: "notes.md", content: doc } }),
      JSON.stringify({ tool: "write_file", args: { path: "page.html", content: "```html\n<b>hi</b>\n```" } }),
      "done",
    ]),
  });
  const r = await agent.run({
    dir,
    task: "two files",
    onTrace: (e) => {
      if (e.type === "approval-request") agent.provideApproval(e.approvalId, true);
    },
  });
  assert.strictEqual(r.wrote, true);
  assert.strictEqual(fs.readFileSync(path.join(dir, "notes.md"), "utf8"), doc);
  assert.strictEqual(fs.readFileSync(path.join(dir, "page.html"), "utf8"), "<b>hi</b>");
});

/* ------------------------------------------- code in the reply, no call --- */

/*
 * v0.40.2 — the second, more common way this feature looked broken:
 *
 *   "Why does it keep giving me code in the chat instead of making actual
 *    folders and files?"
 *
 * Here the model never ATTEMPTS a tool call. Asked to build a page it writes
 * the page into its reply inside a ```html fence and stops. salvageAction has
 * nothing to salvage and looksLikeToolCall correctly says no — this is a third
 * state the loop had no name for: not a tool call, and not really an answer.
 */

test("answeredWithCode: a file yes, an illustration no", () => {
  assert.ok(answeredWithCode("Here:\n```html\n<!DOCTYPE html>\n<html><body><div>0</div></body></html>\n```"));
  // Both thresholds matter, in both directions.
  assert.ok(!answeredWithCode("Set it like this: ```js\nconst x = 1;\n```"), "one short line is a snippet");
  assert.ok(!answeredWithCode("Run:\n```\nnpm install\nnpm test\n```"), "two short lines are advice");
  assert.ok(!answeredWithCode("The calculator needs a display and a keypad."));
  assert.ok(!answeredWithCode(""));
});

test("code in the reply and nothing on disk is nudged into a real write", async () => {
  const dir = tmpProject();
  const agent = new CodeAgent({
    chatFn: scriptedChat([
      "Sure! Here is a simple calculator:\n\n```html\n<!DOCTYPE html>\n<html><body><div class=\"calc\">0</div></body></html>\n```\n\nSave this as calculator.html.",
      JSON.stringify({
        tool: "write_file",
        args: { path: "calculator.html", content: '<!DOCTYPE html>\n<html><body><div class="calc">0</div></body></html>' },
      }),
      "Created calculator.html.",
    ]),
  });
  const notes = [];
  const r = await agent.run({
    dir,
    task: "make me a calculator page",
    onTrace: (e) => {
      if (e.type === "note") notes.push(e.text);
      if (e.type === "approval-request") agent.provideApproval(e.approvalId, true);
    },
  });
  assert.ok(notes.some((t) => /not saved to any file/.test(t)), `expected the nudge, got ${JSON.stringify(notes)}`);
  assert.strictEqual(r.wrote, true);
  assert.ok(fs.existsSync(path.join(dir, "calculator.html")), "the folder must not still be empty");
});

test("the nudge offers BOTH doors: explaining is a real answer, not a forced write", async () => {
  const dir = tmpProject();
  // "Show me how a fetch wrapper looks" — the answer IS a code block, and
  // creating a file nobody asked for would be the wrong repair.
  const agent = new CodeAgent({
    chatFn: scriptedChat([
      "A fetch wrapper looks like this:\n\n```js\nasync function get(url) {\n  const r = await fetch(url);\n  return r.json();\n}\n```",
      '{"answer": true}',
      "That is the shape — no file was needed.",
    ]),
  });
  const r = await agent.run({ dir, task: "show me what a fetch wrapper looks like" });
  assert.strictEqual(r.wrote, false);
  assert.deepStrictEqual(fs.readdirSync(dir), [], "nothing may be invented on disk");
  assert.match(r.answer, /no file was needed/);
});

test("a model that will not budge still finishes, bounded", async () => {
  const dir = tmpProject();
  const stubborn = "Here you go:\n\n```html\n<!DOCTYPE html>\n<html><body>hi there friend</body></html>\n```";
  const agent = new CodeAgent({ chatFn: scriptedChat([stubborn, stubborn, stubborn, stubborn, stubborn]) });
  const r = await agent.run({ dir, task: "make a page" });
  // Nudged at most MAX_NUDGES times, then the code comes back as the answer
  // rather than the loop spinning to its step budget.
  assert.strictEqual(r.reason, "answered");
  assert.ok(r.steps <= 3, `expected a bounded number of tries, got ${r.steps}`);
  assert.strictEqual(r.wrote, false);
});

test("plan mode is prose by design and is never nudged for it", async () => {
  const dir = tmpProject();
  const agent = new CodeAgent({
    chatFn: scriptedChat(["1. Create calculator.html:\n\n```html\n<!DOCTYPE html>\n<html><body>0</body></html>\n```"]),
  });
  const notes = [];
  const r = await agent.run({ dir, task: "plan a calculator", mode: "plan", onTrace: (e) => e.type === "note" && notes.push(e.text) });
  assert.strictEqual(r.reason, "planned");
  assert.ok(!notes.some((t) => /not saved/.test(t)), "a plan is not a failed write");
});
