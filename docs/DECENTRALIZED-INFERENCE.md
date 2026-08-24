# Decentralized Inference — the program

**Status:** driving focus, opened by the owner 2026-08-24.
**Owner's framing, verbatim:** *"limiting hardware seems like it will be a major
obstacle on bringing on the average pc owner and still competing with major AI
platforms."*

That sentence is the whole brief. Two constraints that look separate are the
same constraint:

- **Supply side.** The average PC owner has 8–16 GB of RAM and no serious GPU.
  Today we can only offer them small models, which means small earnings, which
  means they leave. Our addressable supply is capped by what one machine can
  hold.
- **Demand side.** We cannot compete with a hyperscaler on models we cannot
  serve. A network of machines that each run a 4B model is a network that loses
  every comparison to a frontier API.

One answer fixes both: **make many weak machines add up to one strong model.**

This document is the reference for that program. It exists so the reasoning
survives the session it was worked out in, and so that anybody picking this up
starts from the physics rather than from optimism.

---

## 1. The physics, before anything else

### Bandwidth is not the problem

Split a transformer by layers and what crosses the wire between two nodes is one
hidden-state vector per token. For a 70B-class model (hidden dim ≈ 8192, fp16)
that is **~16 KB per token per hop**, or ~8 KB quantized to int8. At 20 tok/s
that is roughly **2.6 Mbps** — unremarkable for home broadband.

Anyone who tells you decentralized inference is blocked on bandwidth has not run
the numbers. Weight *distribution* is a bandwidth problem (tens of GB, once);
inference is not.

### Latency is the problem

Autoregressive generation is sequential. Every token must traverse the whole
model before the next token can begin. So:

```
per-token latency ≈ (hops) × (round-trip time) + compute
```

| Topology | Hops × RTT | Per token | Speed |
|---|---|---|---|
| Global swarm | 8 × 50 ms | 400 ms | **2.5 tok/s** |
| Regional cluster | 8 × 10 ms | 80 ms | **12 tok/s** |
| Same building | 8 × 1 ms | 8 ms | 125 tok/s |

The first row is roughly where **Petals** has sat since 2022 — about one decode
step per second across volunteer GPUs. **Parallax** (2025) improved on that
baseline by ~3.6× throughput and ~3.2× latency. This is a populated research
area with serious teams in it. We will not win by inventing a better sharding
algorithm.

### Two dead ends, killed on sight

- **Tensor parallelism** (splitting *within* a layer). Needs an all-reduce every
  layer at NVLink bandwidth. It will never work over the public internet. Do not
  let anyone reopen this.
- **"One giant dense model spread over Raspberry Pis."** The memory arithmetic
  buries you before latency gets a chance, and it is the wrong goal anyway
  (§6).

---

## 2. The opening, and why it belongs to us

**Speculative decoding.** A small model drafts *k* tokens cheaply; the big model
verifies all *k* in a **single** forward pass, because verification is parallel
across sequence positions rather than sequential. You pay the pipeline traversal
**once per k tokens instead of once per token.**

With 8 hops at 50 ms (400 ms per traversal), and expected accepted tokens
`(1 − α^(k+1)) / (1 − α)`:

| Drafter | Accepted per traversal | Effective |
|---|---|---|
| none (baseline) | 1.0 | 2.5 tok/s |
| α = 0.70, k = 8 | ~3.2 | **8 tok/s** |
| α = 0.85, k = 12 | ~5.9 | **14.6 tok/s** |

That last row is chat-usable across a globally distributed swarm.

**The drafter has to run somewhere, and ours already does.** Every Koinos AI
install is a working local model on the user's own hardware — on Windows, Linux,
arm64 and a Raspberry Pi, with a year of field bugs beaten out of it. Petals,
Parallax, Darkbloom and the Solana-based projects all have thin clients. To copy
this they would have to build our app first.

This is the asymmetry the whole program rests on. **Our edge is not the sharding.
It is that we already own the last mile.**

Research is converging on the same idea — *Privacy-Aware Split Inference with
Speculative Decoding for LLMs over Wide-Area Networks* (Feb 2026) is close to
this design. Nobody has shipped it as a consumer product.

---

## 3. Architecture

### 3.1 Early layers stay local

The first few transformer layers run on the user's own machine. This buys two
things at once:

1. **A shorter network path** — fewer remote hops per traversal.
2. **The privacy answer.** Hidden states can be inverted to recover the original
   prompt, and the *earliest* activations are the most readable. Every
   split-inference design leaks to every node in its pipeline; this is the
   honest mitigation, and again only we can offer it.

### 3.2 Mixture-of-Experts, not dense

MoE activates a small fraction of parameters per token, so a node holds a few
experts rather than a slice of everything. The swarm collectively serves a model
none of its members could afford to.

**The trap:** naive per-layer expert routing means a round trip *per layer* —
32 layers, 32 RTTs, strictly worse than pipelining.

**The fix:** co-location. A node holds a contiguous **run of layers × a subset of
experts**, and routing prefers nodes that already hold the experts the next few
layers will want. Expert usage is heavily Zipfian in practice, so CDN-style
replication of hot experts means a node holding the top few for its layer range
covers most traffic; misses reroute.

### 3.3 Latency-aware topology

The scheduler already does perf-fed routing on throughput and reliability. This
adds a second dimension: workers measure RTT to each other, the scheduler builds
a topology graph, and pipelines are assembled from geographic neighbours rather
than from whoever answered first.

Highest leverage per unit of work in the entire program, and it is useful even
if every later phase is abandoned.

### 3.4 Verification comes partly free

A network node could return plausible-looking garbage. Re-running everything
defeats the point. But under this architecture the **local drafter gives us a
prior**: when a verifier's logits disagree with the drafter's distribution in a
statistically implausible way, that is a fraud signal — cheap anomaly detection
as a side effect of the design, layered on top of the seed-challenge and
mystery-chat machinery already in the scheduler.

Not sufficient alone. Redundant recomputation of a sampled layer on a second
node remains the backstop.

---

## 4. Phases

| Phase | What | Touches | Risk |
|---|---|---|---|
| **0** | Worker-to-worker latency map, **shadow only** | worker report, scheduler storage | Low |
| **1** | Local draft → network verify. **No sharding.** | worker, scheduler, app | Low–medium |
| **2** | Regional 2–4 stage pipelines, **async workloads only** | routing | Medium |
| **3** | MoE expert swarm + BitTorrent-style weight distribution | everything | The real prize |

### Phase 0 — the latency map

Workers opportunistically measure RTT to a handful of peers and report the
results as an extra field on the existing producer/status payload. The scheduler
stores it and **does nothing with it**. No routing change, no payout change, no
effect on earning.

This is deliberately a **shadow rollout**, the same pattern used for the
anti-Sybil fingerprint signal: collect the data, watch it for a while, and only
then let it influence anything that touches money. The revenue path does not get
speculative surgery.

Deliverable: a topology graph we can look at, and an honest answer to "are there
even enough co-located machines for a regional pipeline?" That answer determines
whether Phase 2 is real or fantasy — and it is currently unknown.

### Phase 1 — draft locally, verify on the network

Needs **no sharding whatsoever**. One network node still holds the whole model;
the user's machine drafts *k* tokens and ships them for verification in a single
pass.

Wins immediately and independently: network chat gets faster, and each request
consumes less network compute, which means the same supply serves more demand.
It also builds and hardens the draft/verify protocol that Phases 2 and 3 both
depend on. **This is where the code should start.**

### Phase 2 — regional pipelines, async first

Chat is the hardest latency target and the wrong beachhead. Summarize this
document, review this repo, run this agent overnight, embed this corpus — those
tolerate 30 seconds and do not care about per-token latency at all. Prove the
substrate where latency does not matter, then bring speculative decoding to
chat once it works.

### Phase 3 — the expert swarm

Weight distribution as a BitTorrent-style swarm; nodes specialize and stay
specialized; routing follows the weights instead of moving them.

---

## 4a. MEASURED, 2026-08-24 — what llama.cpp actually does

Run 32682137327, job 97300522997, `core/scripts/spec-decode-probe.js` against
a current llama.cpp release build. Two findings, one of which corrects this
document.

### The batching economics are real

| | |
|---|---|
| 6 separate single-token decodes | 47 ms |
| one pass over prompt + 6 drafts | 7 ms |
| **ratio** | **6.7×** |

Prompt processing clocked ~6,970 tok/s against a decode path an order of
magnitude slower. Evaluating a draft in one batched pass is genuinely far
cheaper than generating those tokens one at a time. The premise holds.

### The API to exploit it is missing

Fed `prompt + k drafts`, the server evaluates all of it (`tokens_evaluated: 42`)
but reports `completion_probabilities` for **one position only** — the last.

- **A**, `/v1/completions` with `echo:true, logprobs:1` → no per-prompt-token values.
- **B**, `/completion` with `n_predict:0` → one entry, not k.
- **C**, `n_predict:1` → confirms it: final position only.
- **D**, a client-supplied `draft` field → accepted without error, which proves
  only that unknown JSON fields are ignored. Not support.

So the compute is cheap and available; the numbers just cannot be read back.
Phase 1 needs a patched llama.cpp, a different engine, or a different
formulation — and shipping a patched build across Windows, Linux, arm64 and a
Pi is a real maintenance burden, not a footnote.

### The correction — Phase 1 was mis-argued

§4 claimed Phase 1 "wins immediately and independently" by making network chat
faster. **That claim was wrong, and the probe is what exposed it.**

With ONE node holding the whole model, network RTT is paid once per *request*,
not per token — the server already generates many tokens per call and streams
them back. There is no per-token network cost to amortise, so local drafting
cannot make an unsharded request faster. Speculative decoding earns its keep
when a model is SHARDED and every token crosses the wire N times. That is
Phase 2/3, not Phase 1.

Phase 1 does still have a real benefit, but it is a different one: **throughput,
not latency.** Verifying k tokens costs one prefill pass where generating them
costs k decode passes, so a drafting client frees ~6.7× the server work per
token — the same supply serves more demand. Worth having. Not what was written.

**Consequence for sequencing:** Phase 0 (the latency map) is now the honest
place to start, because whether Phase 2 is possible at all depends on whether
enough machines are close enough to each other to form a regional pipeline —
and nobody knows that yet. Phase 1 is blocked on an engine capability and
should not be built until that is settled.

## 5. Open problems we have not solved

Written down because a plan that hides its unknowns is a plan that fails at the
worst moment.

- **KV cache pins sessions to nodes.** Each stage holds KV cache for its layers
  for the life of a conversation. It grows with context, it is real RAM on
  someone's home PC, and it means a session cannot be freely rerouted. Losing a
  node mid-conversation loses that stage's cache.
- **Churn.** Consumer machines sleep, reboot, and lose Wi-Fi mid-generation.
  Needs warm standbys, activation checkpoints, or graceful recompute.
- **Activation privacy.** §3.1 mitigates, it does not solve. Deep-layer
  activations still leak *something*. Darkbloom's answer here — Secure Enclave
  attestation, hardened process, coordinator in a confidential VM — is
  structurally stronger than ours on the network path, and we should not pretend
  otherwise in public copy.
- **Cold start.** Tens of GB of weights onto residential connections before a
  node earns anything. What is the incentive to sit through that?
- **The coordinator is still us.** One scheduler on one box assembles these
  pipelines. Decentralizing the coordinator is a separate program and not this
  one.

---

## 6. Two framings to hold onto

**Chat is not the beachhead.** Async and batch work wins first, at prices nobody
can match, and it does not require solving latency at all.

**"One major model" is probably the wrong goal.** The prize is not running a
405B model on weak hardware to prove it can be done. It is serving a model
*whose economics are impossible any other way* — where the point is that nobody
had to buy a datacenter. That is a story about cost and ownership, which is the
story the product already tells.

---

## 7. References

- Petals — *Collaborative Inference and Fine-tuning of Large Models*, arXiv 2209.01188
- *Distributed Inference and Fine-tuning of LLMs Over The Internet*, arXiv 2312.08361
- Parallax, arXiv 2509.26182
- *Privacy-Aware Split Inference with Speculative Decoding for LLMs over WANs*, arXiv 2602.16760
- *Utility-Driven Speculative Decoding for Mixture-of-Experts*, arXiv 2506.20675
- *Making Every Verified Token Count: Adaptive Verification for MoE Speculative Decoding*, arXiv 2605.00342
