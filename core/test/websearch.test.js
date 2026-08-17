"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { searchWeb, fetchPage, isPublicHttpUrl, parseDdgHtml } = require("../lib/websearch");

/*
 * Web search runs Core-side behind the §7 privacy gate. These tests use an
 * injected fetch — ZERO real egress happens in the suite (the same property
 * network.test.js polices for chat).
 */

const DDG_FIXTURE = `
<div class="result">
  <a rel="nofollow" class="result__a" href="/l/?uddg=https%3A%2F%2Fkoinos.io%2Fwhitepaper&amp;rut=abc">Koinos <b>Whitepaper</b></a>
  <a class="result__snippet" href="/l/?uddg=x">The first free-to-use blockchain.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://example.com/page">Example Page</a>
  <div class="result__snippet">Some other <b>snippet</b> text.</div>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="http://127.0.0.1:41100/core/keys">Evil local</a>
</div>`;

test("websearch: DDG parser extracts titles, decodes redirect URLs, drops private targets", () => {
  const results = parseDdgHtml(DDG_FIXTURE);
  assert.strictEqual(results.length, 2, "the localhost result is dropped");
  assert.strictEqual(results[0].url, "https://koinos.io/whitepaper", "uddg redirect decoded to the real URL");
  assert.strictEqual(results[0].title, "Koinos Whitepaper", "tags stripped from titles");
  assert.ok(results[0].snippet.includes("free-to-use"), "snippets ride along");
});

test("websearch: falls back to Wikipedia when DDG is down; returns unreachable when both are", async () => {
  const wikiFetch = async (url) => {
    if (url.includes("duckduckgo")) throw new Error("down");
    return {
      ok: true,
      json: async () => ["koinos", ["Koinos"], ["A blockchain framework."], ["https://en.wikipedia.org/wiki/Koinos"]],
    };
  };
  const r = await searchWeb("koinos", { fetchImpl: wikiFetch });
  assert.strictEqual(r.source, "wikipedia");
  assert.strictEqual(r.results[0].url, "https://en.wikipedia.org/wiki/Koinos");

  const allDown = async () => { throw new Error("down"); };
  const r2 = await searchWeb("koinos", { fetchImpl: allDown });
  assert.strictEqual(r2.source, "unreachable");
  assert.strictEqual(r2.results.length, 0, "failure is empty results, never a throw");
});

test("websearch: SSRF guard — loopback, private ranges, IPv6, non-http all refused", () => {
  for (const bad of [
    "http://localhost/x", "http://127.0.0.1:41100/core/keys", "http://10.0.0.5/", "http://192.168.1.1/",
    "http://172.16.0.9/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "file:///etc/passwd",
    "javascript:alert(1)", "http://router.local/",
  ]) {
    assert.strictEqual(isPublicHttpUrl(bad), false, `${bad} must be refused`);
  }
  assert.strictEqual(isPublicHttpUrl("https://koinos.io/x"), true);
});

test("websearch: fetchPage extracts readable text, strips chrome, caps size, refuses private urls", async () => {
  const page = `<html><head><title>My Doc</title><style>.x{}</style></head>
    <body><nav>MENU</nav><script>evil()</script><p>Real content here.</p><footer>foot</footer></body></html>`;
  const fetchImpl = async () => ({
    ok: true,
    headers: { get: () => "text/html; charset=utf-8" },
    text: async () => page,
  });
  const out = await fetchPage("https://example.com/doc", { fetchImpl });
  assert.strictEqual(out.title, "My Doc");
  assert.ok(out.text.includes("Real content here."));
  assert.ok(!out.text.includes("MENU") && !out.text.includes("evil()") && !out.text.includes("foot"), "nav/script/footer stripped");

  const big = async () => ({ ok: true, headers: { get: () => "text/html" }, text: async () => "<p>" + "a".repeat(50000) + "</p>" });
  const capped = await fetchPage("https://example.com/big", { fetchImpl: big, maxChars: 500 });
  assert.ok(capped.text.length <= 500, "extraction is capped");

  await assert.rejects(() => fetchPage("http://127.0.0.1/core/keys", { fetchImpl }), /public http/);
  await assert.rejects(
    () => fetchPage("https://example.com/bin", { fetchImpl: async () => ({ ok: true, headers: { get: () => "application/octet-stream" }, text: async () => "x" }) }),
    /not a text page/
  );
});

test("gateway: /core/search and /core/fetch are hard-refused without an explicit non-local privacy mode", async () => {
  // A gateway with NO network policy controller defaults to the safest
  // reading (local-only) — the routes must refuse before any egress code.
  const { Gateway } = require("../lib/gateway");
  const gw = new Gateway({ port: 0, runtime: { list: () => [] } });
  const port = await gw.listen();
  try {
    for (const p of ["/core/search", "/core/fetch"]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p === "/core/search" ? { q: "anything" } : { url: "https://example.com" }),
      });
      assert.strictEqual(r.status, 403, `${p} refuses in local-only`);
      const j = await r.json();
      assert.match(j.error, /Local-Only/i);
    }
  } finally {
    await gw.close();
  }
});
