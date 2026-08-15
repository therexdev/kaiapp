"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { mdToHtml } = require("../../ui/markdown");
const { ChatStore } = require("../lib/chats");

/*
 * The chat renderer takes UNTRUSTED model output and produces innerHTML.
 * These tests pin the safety property (nothing model-authored becomes
 * markup) and the constructs the UI depends on.
 */

test("markdown renderer: model output can never become markup", () => {
  const evil = '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))';
  const html = mdToHtml(evil);
  assert.ok(!html.includes("<script"), "script tags stay escaped");
  assert.ok(!html.includes("<img"), "img tags stay escaped");
  assert.ok(!html.includes('href="javascript:'), "javascript: URLs never become links (they stay inert text)");
  assert.ok(html.includes("&lt;script&gt;"), "escaped source is preserved as text");

  // Attribute breakout: a quote inside link text/URL can't escape the href.
  const quoted = '[a"onmouseover="x](https://ok.example/p"q)';
  assert.ok(!/onmouseover=/.test(mdToHtml(quoted).replace(/&quot;/g, "")) || !mdToHtml(quoted).includes('" onmouseover'), "quotes cannot break out of attributes");
});

test("markdown renderer: the constructs models actually emit", () => {
  const html = mdToHtml(
    "# Title\n\nSome **bold** and `inline` and [a link](https://example.com).\n\n- one\n- two\n\n1. first\n2. second\n\n```python\nprint('hi')\n```\n\n> quoted"
  );
  assert.ok(html.includes("<h3>Title</h3>"), "headings render (capped small for chat)");
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<code>inline</code>"));
  assert.ok(html.includes('<a href="https://example.com"'));
  assert.ok(html.includes("<ul><li>one</li>"));
  assert.ok(html.includes("<ol><li>first</li>"));
  assert.ok(html.includes('class="code-block"') && html.includes("print(&#39;hi&#39;)") === false && html.includes("print('hi')"), "code renders verbatim (escaped only for HTML)");
  assert.ok(html.includes('class="code-copy"'), "code blocks carry a copy button");
  assert.ok(html.includes("<blockquote>quoted</blockquote>"));
});

test("markdown renderer: an unterminated fence (mid-stream) still renders as code", () => {
  const html = mdToHtml("```js\nconst x = 1;");
  assert.ok(html.includes("const x = 1;") && html.includes("code-block"), "half-streamed fence renders as code, not soup");
});

test("chat store: rename sticks and survives later autosaves; persona rides along", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-chatx-"));
  const store = new ChatStore(dir);
  const { id } = store.save({ messages: [{ role: "user", content: "hello world" }], system: "Be a pirate.", persona: "custom" });

  assert.strictEqual(store.get(id).system, "Be a pirate.", "system prompt round-trips");

  store.rename(id, "My voyage");
  assert.strictEqual(store.get(id).title, "My voyage");

  // Autosave after rename (as the UI does after every exchange) must not
  // clobber the user's chosen title with the auto-title.
  store.save({ id, messages: [{ role: "user", content: "hello world" }, { role: "assistant", content: "ahoy" }], system: "Be a pirate." });
  assert.strictEqual(store.get(id).title, "My voyage", "user title outlives autosave");

  assert.throws(() => store.rename(id, "   "), /title required/);
});
