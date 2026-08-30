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

const net = require("net");
const dns = require("dns").promises;

const MAX_RESULTS = 5;
const MAX_REDIRECTS = 5;
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

/*
 * SSRF guard: only public http(s) targets. The core's own control plane lives
 * on 127.0.0.1 — a prompt-injected "fetch this URL" must never be able to read
 * it, or anything else on the LAN, or a cloud metadata service.
 *
 * Checking the hostname STRING is where this used to stop, and a string is not
 * a destination. Two ways past it, neither exotic:
 *   · a name. evil.example resolving to 127.0.0.1 is a perfectly ordinary DNS
 *     record and sails through any spelling test.
 *   · a redirect. A public URL answering 302 Location: http://169.254.169.254/
 *     was followed without a second look, because fetch followed it for us.
 * So the check now happens against resolved addresses, and again at every hop.
 */

/** True when a resolved IP belongs to something that is not the public internet. */
function isPrivateAddress(addr) {
  const ip = String(addr || "").toLowerCase();
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||                        // this network
      a === 10 ||                       // RFC1918
      a === 127 ||                      // loopback
      (a === 169 && b === 254) ||       // link-local, incl. 169.254.169.254 metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 192 && b === 0) ||         // IETF protocol assignments + TEST-NET-1
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      (a === 198 && b === 51) ||        // TEST-NET-2
      (a === 203 && b === 0) ||         // TEST-NET-3
      a >= 224                          // multicast, reserved, broadcast
    );
  }
  if (net.isIPv6(ip)) {
    // Compare bytes, never spelling. ::ffff:127.0.0.1 and ::ffff:7f00:1 are
    // the same address, and the URL parser hands back whichever it likes.
    const b = ipv6Bytes(ip);
    if (!b) return true; // cannot parse it, so cannot vouch for it
    const zeros = (from, to) => b.slice(from, to).every((x) => x === 0);
    if (zeros(0, 16)) return true;                              // ::
    if (zeros(0, 15) && b[15] === 1) return true;               // ::1
    if ((b[0] & 0xfe) === 0xfc) return true;                    // fc00::/7 unique-local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;   // fe80::/10 link-local
    if (b[0] === 0xff) return true;                             // multicast
    // Addresses that carry an IPv4 inside them are that IPv4.
    const embedded = () => isPrivateAddress(b.slice(12, 16).join("."));
    if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return embedded();     // ::ffff:0:0/96
    if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return embedded(); // NAT64
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddress(b.slice(2, 6).join(".")); // 6to4
    return false;
  }
  return true; // not an address we understand — refuse
}

/** An IPv6 literal as its 16 bytes, or null. Folds in a dotted-quad tail so
 *  every spelling of the same address compares equal. */
function ipv6Bytes(ip) {
  let text = String(ip);
  const dotted = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) {
    const q = dotted[1].split(".").map(Number);
    if (q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text =
      text.slice(0, text.length - dotted[1].length) +
      (((q[0] << 8) | q[1]) >>> 0).toString(16) + ":" + (((q[2] << 8) | q[3]) >>> 0).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 255, n & 255);
  }
  return bytes;
}

/** Cheap syntactic gate: scheme, obviously-local names, literal IPs. Stays
 *  synchronous because callers use it to filter lists of search results. */
function isPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  let host = u.hostname.toLowerCase();
  if (host === "" || host === "localhost") return false;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost") || host.endsWith(".home.arpa")) return false;
  // URL normalises IPv6 literals in brackets; strip them to test the address.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (net.isIP(host)) return !isPrivateAddress(host);
  return true;
}

/**
 * The check that actually decides: resolve the name and refuse if ANY answer
 * points somewhere private. Throws with the reason, so refusals are legible
 * in a trace rather than looking like a network failure.
 *
 * Residual gap, stated plainly: between this lookup and the socket's own, the
 * record could change (classic DNS rebinding). Closing that needs the request
 * pinned to the address checked here, which means owning the connection —
 * worth doing if this surface ever widens, and out of proportion to a local
 * assistant fetching an article today.
 */
async function assertPublicTarget(raw, { lookup = dns.lookup } = {}) {
  if (!isPublicHttpUrl(raw)) throw new Error("only public http(s) URLs can be fetched");
  let host = new URL(String(raw)).hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (net.isIP(host)) return; // a literal was already judged on its own merits

  let answers;
  try {
    answers = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`cannot resolve ${host}`);
  }
  if (!answers || !answers.length) throw new Error(`cannot resolve ${host}`);
  for (const a of answers) {
    if (isPrivateAddress(a.address)) {
      throw new Error(`refusing ${host}: it resolves to a private address`);
    }
  }
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
 *  only, checked against resolved addresses at every hop — see
 *  assertPublicTarget. */
async function fetchPage(url, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS, maxChars = PAGE_CAP_CHARS, lookup } = {}) {
  /*
   * Redirects are followed by hand. `redirect: "follow"` hands the decision to
   * fetch, which will happily walk a public URL to http://169.254.169.254/ or
   * to the app's own control plane on 127.0.0.1 — the guard on the URL the
   * caller supplied says nothing about where it points next. Every hop is a
   * fresh destination and gets a fresh check.
   */
  let target = String(url);
  let r;
  for (let hop = 0; ; hop++) {
    await assertPublicTarget(target, { lookup });
    r = await fetchImpl(target, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "Mozilla/5.0 (KoinosAI local assistant)", accept: "text/html,text/plain" },
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(r.status)) break;
    const location = r.headers.get("location");
    try { await r.body?.cancel(); } catch { /* nothing to drain */ }
    if (!location) throw new Error(`fetch failed: http ${r.status} with no location`);
    if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
    target = new URL(location, target).toString();
  }
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
  // The URL that was actually read, not the one that was asked for — a caller
  // citing a source should cite where the words came from.
  return { title, url: target, text };
}

module.exports = { searchWeb, fetchPage, isPublicHttpUrl, isPrivateAddress, assertPublicTarget, parseDdgHtml };
