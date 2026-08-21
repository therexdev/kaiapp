# Grounded answers from the API — design (owner ask 2026-08-21)

The ask: let someone build a support bot or company chatbot **on top of the
Koinos AI API** without writing their own agent loop. Today a developer who
wants a web- or docs-grounded answer has to build search, fetching, chunking,
and the tool loop on their side, then hand us the assembled prompt. That is a
lot of scaffolding for what most people want, which is "answer from THIS
material."

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
   (task #63, owner-deferred) in its sharpest form — allowing node-side egress
   would force that decision immediately instead of at more usage.
3. **Operators never consented to be an egress proxy.** They signed up to serve
   inference. Turning their machine into an open fetcher is a different deal
   than the one they agreed to.
4. **The result is unverifiable.** A dishonest node can invent "fetched"
   content. The caller cannot tell. Our §17 challenge machinery scores
   inference quality, not fetch honesty — we would be trusting strangers with
   the factual grounding of someone's support bot.
5. **Unbounded cost on someone else's bandwidth.**

**Decision: node-side fetching is refused, permanently, not "later".** If a
request asks for grounding tools AND routes to `koinos-network`, the gateway
answers with a clear error naming the local path instead.

## Where grounding SHOULD live: the caller's own Core

The trust story is already right on a machine the developer controls. It is
their hardware, their network, their privacy switch — and the pieces exist:

- `/core/search` + `/core/fetch` with the `isPublicHttpUrl` SSRF guard
  (loopback, RFC1918, link-local/metadata, IPv6 literals all refused).
- The one tool registry with its egress/sensitive policy.
- The agent loop (`ui/agents.js`) and the research loop already shipped in the
  app.

What is missing is only this: none of it is reachable through the
**OpenAI-compatible** surface, so an API consumer cannot get it without
rebuilding it. That is the actual gap — not a missing capability, a missing
door.

## Proposal — two shapes, one opt-in extension

Add an optional `koinos` block to `/v1/chat/completions`. Absent it, behaviour
is byte-identical to today. Requires an API key (already true for `/v1`), obeys
the privacy switch (Local-Only refuses in words), local models only.

### Shape A — web grounding (open questions)

```json
{
  "model": "koinos-fast",
  "messages": [{"role": "user", "content": "What changed in the EU AI Act this month?"}],
  "koinos": { "ground": { "web": true, "max_pages": 3 } }
}
```

Core runs the existing search→read→answer loop internally and returns a normal
OpenAI-shaped completion, with the sources attached (`koinos.citations`) so the
caller can show them. The developer writes zero agent code.

### Shape B — source grounding (what support bots actually need)

Company bots rarely want the open web; they want **their own material**. So:

```json
{
  "koinos": { "ground": {
    "sources": ["https://help.acme.com/**", "https://acme.com/docs/**"],
    "max_pages": 4
  }}
}
```

An explicit allowlist. Core fetches only matching public URLs (same SSRF
guard), grounds the answer in them, and cites them. No crawler, no index to
maintain, nothing to keep warm — and the allowlist doubles as the safety
bound, since the caller has named exactly what may be fetched.

Later, if field use asks for it: a persistent indexed collection
(`/core/knowledge`) reusing the existing local TF-IDF memory store, so a bot
can be grounded in a large doc set without re-fetching per call. Deliberately
NOT phase one — the allowlist covers the common case and ships far sooner.

## Rules that hold in both shapes

- **Local models only.** `koinos-network` + grounding = refused, with the error
  naming why and pointing at the local path.
- Privacy switch first: Local-Only refuses grounding in words, as everywhere.
- Bounded: page cap, per-fetch timeout, total byte cap, one loop, no recursion.
- Fetched text is **untrusted input**. It is framed as reference material in
  the prompt, never as instructions — a page that says "ignore your
  instructions" is data, not a command.
- Citations always returned when grounding ran, so an operator of the bot can
  audit what its answers were based on.
- Off by default. A caller who never sends `koinos` sees no change at all.

## Why this is worth doing

It turns "you must build a RAG pipeline to use our API" into "add four lines of
JSON" — for exactly the customers (support bots, company assistants) most
likely to run a Core of their own and pay for network inference on the harder
questions. And it does it without asking a single volunteer operator to become
an open proxy.

STATUS: design only, awaiting the owner's go-ahead. Nothing implemented.
