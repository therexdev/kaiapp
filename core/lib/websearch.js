"use strict";

/*
 * Web search + page fetch for chat (Core-side by necessity: the renderer's
 * CSP is connect-src 'self', so all egress happens here, behind the §7
 * privacy gate in the gateway — Local-Only mode never reaches this module).
 *
 * Keyless by design: DuckDuckGo's HTML endpoint is the primary source and
 * Wikipedia's opensearch API the fallback, so search works out of the box
 * with no account and no API key to leak. Both are plain HTTPS GETs of the
 * user's QUERY only — never chat history.
 *
 * fetchImpl is injectable so tests run with zero real egress.
 */

const MAX_RESULTS = 5;
const FETCH_TIMEOUT_MS = 9000;
const PAGE_CAP_CHARS = 6000;

/** Decode HTML entities the two sources actually emit. */
function unescapeHtml(s) {
  return String(s)
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  return unescapeHtml(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** SSRF guard: only public http(s) targets. The core's own control plane
 *  lives on 127.0.0.1 — a prompt-injected "fetch this URL" must never be
 *  able to read it (or anything else on the LAN). Hostname-based; literal
 *  IPs are checked by range. */
function isPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host === "") return false;
  // IPv6 literals: allow none (loopback/link-local/ULA all live here; public
  // sites resolve via hostnames).
  if (host.includes(":")) return false;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}

/** DuckDuckGo HTML results — anchors carry a /l/?uddg=<encoded> redirect. */
function parseDdgHtml(html) {
  const out = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1] || sm[2] || ""));
  let m;
  while ((m = linkRe.exec(html)) !== null && out.length < MAX_RESULTS) {
    let url = unescapeHtml(m[1]);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        /* keep the wrapped url */
      }
    }
    if (url.startsWith("//")) url = "https:" + url;
    if (!isPublicHttpUrl(url)) continue;
    out.push({ title: stripTags(m[2]).slice(0, 120), url: url.slice(0, 500), snippet: (snippets[out.length] || "").slice(0, 300) });
  }
  return out;
}

async function searchWeb(q, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS, ddgUrl, wikiUrl } = {}) {
  const query = String(q || "").trim().slice(0, 400);
  if (!query) return { results: [], source: "none" };
  // Primary: DuckDuckGo HTML (keyless, full-web).
  try {
    const u = (ddgUrl || "https://html.duckduckgo.com/html/") + "?q=" + encodeURIComponent(query);
    const r = await fetchImpl(u, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Mozilla/5.0 (KoinosAI local assistant)", accept: "text/html" },
    });
    if (r.ok) {
      const results = parseDdgHtml(await r.text());
      if (results.length) return { results, source: "duckduckgo" };
    }
  } catch {
    /* fall through to wikipedia */
  }
  // Fallback: Wikipedia opensearch (keyless, reliable JSON, narrower).
  try {
    const u =
      (wikiUrl || "https://en.wikipedia.org/w/api.php") +
      "?action=opensearch&format=json&limit=" + MAX_RESULTS + "&search=" + encodeURIComponent(query);
    const r = await fetchImpl(u, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (r.ok) {
      const [, titles = [], descs = [], urls = []] = await r.json();
      const results = titles
        .map((t, i) => ({ title: String(t).slice(0, 120), url: String(urls[i] || "").slice(0, 500), snippet: String(descs[i] || "").slice(0, 300) }))
        .filter((x) => isPublicHttpUrl(x.url));
      if (results.length) return { results, source: "wikipedia" };
    }
  } catch {
    /* both down */
  }
  return { results: [], source: "unreachable" };
}

/** Fetch one result page and extract readable text (capped). Public URLs
 *  only — see isPublicHttpUrl. */
async function fetchPage(url, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS, maxChars = PAGE_CAP_CHARS } = {}) {
  if (!isPublicHttpUrl(url)) throw new Error("only public http(s) URLs can be fetched");
  const r = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "Mozilla/5.0 (KoinosAI local assistant)", accept: "text/html,text/plain" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`fetch failed: http ${r.status}`);
  const ctype = String(r.headers.get("content-type") || "");
  if (!/text\/html|text\/plain|application\/xhtml/.test(ctype)) throw new Error("not a text page");
  let html = await r.text();
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").slice(0, 200);
  // Readability-lite: drop non-content blocks wholesale, then tags.
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ");
  const text = stripTags(html).slice(0, maxChars);
  if (!text) throw new Error("no readable text");
  return { title, url: String(url), text };
}

module.exports = { searchWeb, fetchPage, isPublicHttpUrl, parseDdgHtml };
