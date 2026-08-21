# Grounded answers from the API — design (owner ask 2026-08-21)

The ask: let someone build a support bot or company chatbot **on top of the
Koinos AI API** without writing their own agent loop. Today a developer who
wants a grounded answer has to build search, fetching, chunking, and the tool
loop on their side, then hand us the assembled prompt. That is a lot of
scaffolding for what most people want, which is "answer from THIS material" —
and increasingly "…and from what is true right now."

## The safety line: network nodes must never fetch on a caller's behalf

This is the part worth being blunt about, because it is the thing that looks
convenient and is not safe.

`POST /v1/chat/completions` with `model: "koinos-network"` does not run
locally — the gateway proxies the request to a **stranger's machine** (an
earning operator). If we let that node fetch a URL supplied by the caller,
five things break at once:

1. **SSRF onto other people's home networks.** A caller could aim a fetch at
   `192.168.1.1`, `169.254.169.254` (cloud metadata), or any internal host
   *inside the operator's LAN*. Our `isPublicHttpUrl` guard blocks those
   ranges, but the moment the fetch runs on a stranger's box the blast radius
   is their network, not ours, and one guard bug becomes everyone's problem.
2. **Attribution lands on the operator.** Fetch traffic carries the operator's
   IP. Scraping, abuse, or illegal content fetched "by the network" is logged
   against a volunteer's home connection. This is the moderation/AUP question
   (task #63, owner-deferred) in its sharpest form.
3. **Operators never consented to be an egress proxy.** They signed up to serve
   inference. Turning their machine into an open fetcher is a different deal
   than the one they agreed to.
4. **The result is unverifiable.** A dishonest node can invent "fetched"
   content. Our §17 challenge machinery scores inference quality, not fetch
   honesty.
5. **Unbounded cost on someone else's bandwidth.**

**Decision: node-side fetching is refused, permanently, not "later".** If a
request asks for grounding AND routes to `koinos-network`, the gateway answers
with a clear error naming the local path instead.

## Where grounding SHOULD live: the caller's own Core

The trust story is already right on a machine the developer controls. It is
their hardware, their network, their privacy switch — and the pieces exist:

- `/core/search` (keyless DuckDuckGo HTML + Wikipedia) and `/core/fetch`, both
  behind `isPublicHttpUrl`: no `localhost`, no `.local`/`.internal`, no IPv6
  literals, none of `0.*`, `10.*`, `127.*`, `169.254.*`, `172.16-31.*`,
  `192.168.*`. Search results are filtered at parse time, not just on fetch.
- Both are already hard-refused unless the privacy switch permits leaving the
  machine (there is a test pinning exactly that).
- The agent loop (`ui/agents.js`) and the research loop already in the app.

What is missing is only this: none of it is reachable through the
**OpenAI-compatible** surface. That is the actual gap — not a missing
capability, a missing door.

## Proposal — ONE opt-in block, two sources that compose

Add an optional `koinos` block to `/v1/chat/completions`. Absent it, behaviour
is byte-identical to today. Requires an API key (already true for `/v1`), obeys
the privacy switch, local models only.

The two sources are NOT separate features. They are two fields on one object,
and the interesting case is both at once:

```json
{
  "model": "koinos-fast",
  "messages": [{"role": "user", "content": "Is the venue open tomorrow?"}],
  "koinos": { "ground": {
    "sources": ["https://help.acme.com/**", "https://acme.com/docs/**"],
    "web": true,
    "max_pages": 4
  }}
}
```

- **`sources` only** — bounded retrieval over the company's own material. An
  explicit URL allowlist; nothing else is ever fetched. Safest shape.
- **`web` only** — open-web grounding for questions no static page answers:
  today's news, the weather, whether a service is down right now.
- **Both** — the honest shape for a real support bot. Their own docs answer
  "how do I reset my password"; the open web answers "is there an outage" and
  "what's the forecast for the event". Allowlisted sources are consulted
  first; the web supplements. Citations say which answer came from where, so
  the company can see when its bot leaned on a stranger's page.

## Open web: what it actually exposes, stated plainly

With an allowlist, the DEVELOPER decides what may be fetched, in their own
server code, and their end users cannot change it. Open web is different and
the difference should not be soft-pedalled:

**In open-web mode, the end user's question steers what the machine fetches
from the public internet.** Someone chatting with the support bot types a
question, the model turns it into a search, and pages come back and get read.
That is not a flaw in our implementation — it is what open-web grounding *is*,
here and everywhere else it exists. The honest framing for the docs is: turning
`web: true` on means your Core will fetch public pages chosen, indirectly, by
whoever is talking to your bot.

What bounds that exposure:

- **Public addresses only.** The SSRF guard applies to every fetch, so it can
  never be turned inward at the company's own network or a metadata endpoint.
- **No tools in the grounding loop.** This is the important one. The loop is
  search → read → answer, and nothing else — no file access, no commands, no
  MCP, no memory writes. So the worst a malicious page can achieve is *a wrong
  or weird answer*. It cannot reach anything, because in this loop there is
  nothing to reach. (Contrast agent mode, which has tools and is human-watched.)
- **One search round by default.** Multi-round would let a fetched page
  influence the NEXT query, which is a narrow but real way for injected text to
  smuggle conversation content into an outbound request. One round closes it.
  Deep research remains the multi-round surface, and it is human-driven.
- **Bounded**: page cap (`max_pages`, default 3, hard ceiling 8), per-fetch
  timeout, total byte cap. Their bandwidth, their caps.
- **Fetched text is untrusted input**, framed as reference material and never
  as instructions. A strong mitigation, not a proof — worth saying out loud.
- **Off by default**, and the allowlist remains available for anyone who wants
  live-data-free operation.

Residual risk we accept and document rather than pretend away: an end user can
cause the company's machine to fetch a public page of roughly their choosing,
and pay the bandwidth for it. Anyone running a web-connected chatbot carries
that. The mitigation is that it is explicit, capped, off unless asked for, and
that the loop it feeds cannot do anything but produce text.

## Rules that hold in every shape

- **Local models only.** `koinos-network` + grounding = refused, with the error
  naming why and pointing at the local path.
- Privacy switch first: Local-Only refuses grounding in words, as everywhere.
- Citations always returned when grounding ran (`koinos.citations`), so the bot
  can show its sources and the operator can audit what an answer rested on.
  Non-negotiable for news answers in particular.
- Off by default. A caller who never sends `koinos` sees no change at all.

Later, if field use asks for it: a persistent indexed collection
(`/core/knowledge`) reusing the existing local TF-IDF memory store, so a bot can
be grounded in a large doc set without re-fetching per call. Deliberately not
phase one.

## Why this is worth doing

It turns "you must build a RAG pipeline to use our API" into "add a few lines of
JSON" — for exactly the customers most likely to run a Core of their own. And it
does it without asking a single volunteer operator to become an open proxy.

## SHIPPED — v0.34.0

Built as designed, both sources together. What landed:

- `core/lib/grounding.js` — spec parsing/validation, glob matching, the one
  retrieval round, the reference framing, and the character budget.
- `core/lib/gateway.js` — `koinos.ground` parsed at the top of `_chat` so a
  malformed block is a clean 400 and the two refusals (network model, Local-
  Only) land before any egress. Grounding runs after the model's context is
  known so the reference is budgeted against it, and a grounded request never
  overflows to the network — "local models only" holds on the fallback paths
  too, or it silently is not a rule.
- `_proxy` gained `extraHeaders` + `injectJson`: citations ride an
  `x-koinos-grounding` header for every call (streaming included) and the JSON
  body for non-streaming ones. Streams are never buffered.
- `Gateway.groundIo` makes search/fetch injectable, so the HTTP tests drive the
  real request path with zero egress.
- Fixture: `FAKE_LLAMA_RECORD` records what the runtime actually received,
  which is how the tests prove the reference material arrived AND that the
  `koinos` field was stripped before it got there.

20 tests in `core/test/grounding.test.js`. Suite: 309 tests, 305 pass,
4 env-skips, 0 fail. The koinos-network refusal was verified fails-on-old by
removing the guard and re-running.

Two bugs the tests caught during the build, both worth recording:

1. `Number(budgetChars) || TOTAL_CHARS` read a budget of ZERO as "unset" and
   handed back the full allowance — injecting the most material exactly when
   the context had room for the least. Now an explicit `Number.isFinite` check.
2. The "concrete URLs need no search" test initially failed because remaining
   page slots were filled by a site:-scoped search. That behaviour is right
   (more of the caller's own material is good); the test was imprecise and now
   pins the property exactly, with `max_pages` filled by the concrete URL.

3. **v0.34.1, found by re-reading the diff rather than by a test.** `koinos`
   was stripped from the body only when grounding actually RAN. A block with no
   `ground` key parses to null, so the field survived and rode on to the local
   runtime — or, on a network request, was serialized and signed into a payload
   sent to a stranger's machine. Now stripped unconditionally: whatever a caller
   puts under our namespace stops at the gateway.

Deliberately NOT built, and still the right calls: node-side fetching (refused
permanently, see above), multi-round grounding, and a persistent
`/core/knowledge` index.
