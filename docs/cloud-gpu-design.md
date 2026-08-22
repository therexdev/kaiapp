# Cloud GPU (RunPod and friends) — design exploration

**Status: DIRECTION SET by the owner 2026-08-22 — first-party seed capacity.
The user-integration half is declined. VRAM gate fixed; everything else below
awaits a spend decision.**
Owner asked how someone could use a service like RunPod to host bigger models
for their own Koinos AI *and* offer them to the network.

Everything in "What is true today" was read out of the code, not recalled.

---

## 0. The headline, first

**These are two different products and only one of them is a good idea right
now.**

- **Using a rented GPU for your own big models** is a genuinely strong offer
  and is mostly a missing *setting*, not a missing system.
- **Renting a GPU to serve the network** is, at today's rates and today's
  demand, **a guaranteed loss** — see §5, where the numbers are worked. It is
  not blocked by anything technical; it is blocked by arithmetic.

**The owner's resolution (§6) took a third path neither of those describes:**
Koinos AI runs the big-model capacity ITSELF, as inventory. That makes the
first bullet unnecessary (nobody needs to integrate a pod to reach a 70B) and
the second one moot (nobody is asked to lose money). §1-§5 are the evidence;
§6 is the decision.

---

## 1. What is true today (verified in code)

| Thing | Reality | Where |
|---|---|---|
| Headless Core | `node core/server.js` runs the whole stack with no window | `core/server.js` (`require.main === module`) |
| GPU engine | NVIDIA → CUDA llama.cpp build, auto-provisioned; Vulkan for Arc/Radeon; CPU fallback | `runtime-provisioner.js:61-67`, `runtime-manager.js:277-280` |
| Worker registration | Wallet + scheduler URL is all it takes | `core/lib/worker.js` |
| What a worker advertises | Catalog models only, **gated on system RAM** | `worker.js:93` |
| Model ceiling | Catalog stops at **32B** | `core/models/catalog.json` |
| Remote Core / remote model | **Does not exist.** The only non-local lane is `koinos-network` → the public scheduler | no `coreUrl`/upstream-runtime anywhere |
| Core auth for remote use | `KAI_CORE_TOKEN` already gates every `/core/*` call | `gateway.js:132-136, 294-296` |
| Device fingerprint | Hash of platform/arch/CPU/cores/RAM-GB/GPU names | `worker.js:25-37` |
| Fingerprint in payouts | **Not in the reputation formula at all** — shadow only | `scheduler.js:767-793`, `2128-2135` |

Two of those deserve to be pulled out.

**The RAM gate is blind to the GPU.** `fits()` compares `minRamGb` against
`os.totalmem()`. A pod with a 48 GB A40 and 16 GB of system RAM is refused the
24 GB and 32 GB classes it could actually serve *well*, while a RAM-rich
CPU-only box is waved through to classes it will serve at a crawl. On consumer
desktops system RAM is a decent proxy for capability. On cloud GPU instances
the two are decoupled by design, and the proxy breaks in both directions.

**The fingerprint already anticipates this exact case**, in its own comment:
*"a fleet of clones on identical VMs also hashes the same — which is exactly
the point."* True — and it cuts the other way too. Every honest person renting
the same RunPod A40 template collides with every *other* honest RunPod A40
renter they have never met. Cloud hardware is fungible; that is what makes it
cloud. As a Sybil signal on cloud operators, this one is close to noise.

---

## 2. Part A — using a big model yourself — **DECLINED, see §6**

*Kept for the reasoning, not as a plan. The owner declined this half: if the
network offers 70B, nobody needs to wire up their own pod to reach one.*

Three shapes. They are not variations; they put the trust boundary in three
different places.

### A1. Point the desktop app at a Core running on the pod

Run headless Core on the pod, add a base-URL setting to the app, set
`KAI_CORE_TOKEN`, put TLS in front.

- **Best capability by far.** Chat, Agent, Teams, Koinos Code, memory — all of
  it runs against the big model, because all of it already runs against Core.
- **Most of the security scaffolding exists.** `KAI_CORE_TOKEN` is built, and
  the gateway already refuses proxied callers on the dangerous routes.
- **Worst privacy cost, and it is not close.** Core holds chats, memory, and —
  through Koinos Code — the contents of your source tree. Relocating Core to a
  rented box moves *all of it* to hardware someone else administers, can image,
  and can seize. The footer of this app says "Nothing leaves this machine."
  This mode makes that sentence false for everything at once.

### A2. Add a remote model alongside the local ones

A catalog entry whose runtime is an OpenAI-compatible base URL. RunPod's vLLM
template already exposes exactly that shape.

- **The trust boundary lands where a person expects it.** You added a remote
  model; prompts sent *to that model* leave. Local models stay local. The model
  picker — which v0.40.0 just made visible — becomes the privacy control, which
  is the right place for it.
- Smallest blast radius: it touches the chat lane, nothing else.
- Weaker: you get inference, not the whole app. Good enough for the actual ask.

### A3. Private worker on the public scheduler

The pod registers as a worker reserved to your own account.

- Reuses all the dispatch machinery.
- But your prompts now traverse the public scheduler to reach your own GPU,
  which is a strange thing to accept for hardware you are paying for outright.

**Recommendation: A2.** It answers the question actually asked ("use more
powerful models"), it puts the privacy decision in front of the person at the
moment they make it, and it does not require rewriting the app's central
promise. A1 is more powerful and should stay on the table as an explicitly
labelled "advanced / self-hosted" mode — but it needs the privacy sentence
rewritten while it is active, not a footnote.

---

## 3. Part B — serving the network from a pod

**This already works.** Nothing needs building for the mechanism: headless
Core + wallet + scheduler URL, and CUDA provisions itself. Five things stand
between "works" and "works well".

1. **dataDir persistence — the known killer.** Already in the source of truth
   from the A40 watch: a container without a persistent volume comes back with
   a new wallet, and `ageDays`/`perf` reset to zero. Reputation is ~40% age. An
   operator who misses this silently resets their earning identity every
   restart. On RunPod this means a Network Volume mounted at `KAI_DATA_DIR`,
   and it is the single most important sentence in any guide we write.
2. **The RAM gate mismatch** (§1). Needs VRAM in the fit rule, or an explicit
   capability declaration, before cloud boxes are advertised honestly.
3. **Fingerprint collisions** (§1). Harmless today — it is shadow-only and not
   in the reputation formula. It stops being harmless when the gate arms
   (~Sep 2) *if* fingerprint is ever folded in. **Decision needed before then,
   not after.**
4. **The catalog stops at 32B.** "Rent a GPU to run bigger models" has no
   bigger models to run. A 48 GB card is currently pointless to the network.
5. **The economics do not work.** §5.

---

## 4. The privacy question, stated plainly

This is the part worth being careful about, because it is the part that cannot
be walked back.

The product's promise is on the footer of every screen. A rented pod is someone
else's computer: the host can image the disk, read RAM, and is subject to
subpoena. That is not a knock on RunPod specifically — it is true of every
rented machine, including this project's own Vultr box.

So the rule should be: **cloud inference is never a default, never inherited,
and never silent.** A person opts a *specific model* in, sees it labelled
wherever it is selected, and the footer stops claiming local-only while it is
in use. That is the same posture already taken for `koinos-network` in Chat and
for the deliberate refusal of network models in Koinos Code — consistent, not
new policy.

---

## 5. The economics — where this gets decided

All inputs verified in `kai/lib/scheduler.js` and the live oracle.

**Rate card**, top class (`qwen25-32b`, `qwen-coder-32b`, `deepseek-r1-32b`):
`$1.00 / 1M` input, **`$4.00 / 1M` output**. Compute takes 90% once the
treasury split is on (100% today, since unset shares fold back to compute).

**Break-even.** Output tokens dominate, so at `T` tokens/sec sustained:

```
revenue/hour = 3600 × T × ($4.00 / 1e6) = $0.0144 × T
break-even T = hourly GPU cost / 0.0144
```

At roughly **$0.40/hr** for an A40 (check current pricing — the formula is the
point, not the number):

> **T ≈ 28 tokens/sec, sustained, at 100% utilisation, output tokens only.**

A 32B Q4 on an A40 lands near that *at full tilt*. So break-even requires the
card to be generating flat out, every second it is rented. Utilisation on a
six-worker network is a rounding error above zero. **The real result is a loss
by one to two orders of magnitude**, and turning on the treasury split moves
break-even further away, not closer.

**The subsidy cannot rescue it, by deliberate design.** The bootstrap pool is
1,500 KAI/day **network-wide** — at the live oracle price (~$0.00897/KAI) that
is **≈ $13.45/day for the entire network**. One A40 at $0.40/hr costs $9.60/day.
A single rented card would consume ~71% of the whole network's daily subsidy.
And the pool divides across verified work rather than paying per machine —
`scheduler.js` says it in its own comment: *"spinning up N machines does not
raise total protocol expense — it only dilutes each machine's share, so Sybil
farming is pointless."* That anti-Sybil property is working exactly as intended.
It also means honest cloud operators cannot be paid enough to cover rent.

**Conclusion:** cloud GPU as a profit-seeking network worker does not work at
current rates and current demand. Anyone told otherwise would lose money, and
they would be right to be annoyed about it.

---

## 6. DECIDED — first-party seed capacity only

Owner, 2026-08-22, after reading §1-§5:

> "the real goal is to get bigger models available on the network. Even as we
> grow, we may not always have super strong hardware on the network until we
> gain enough momentum. There also is a market for people who need these
> stronger models... If we offer that capability then people don't really need
> the capability of integrating cloud hosting to access them and they are not
> profitable earns so don't really make sense for standard miners to do."

That resolves it, and it resolves it well. **Koinos AI runs the big-model
capacity itself.** The user-facing cloud-integration work (§2's A1/A2/A3) is
DECLINED — not deferred. If the network offers 70B, nobody needs to wire up a
pod to reach one, and telling volunteers to rent hardware that loses money
would have been the wrong advice anyway.

This changes what the thing IS. It is no longer a feature; it is **inventory**.
That reframing carries three obligations the earning framing did not.

### 6.1 Seed workers must draw ZERO from the bootstrap pool

Non-negotiable, and it is the reason this section exists.

`_networkSubsidyBudget` divides the pool across **all honest receipts pro-rata**
(`scheduler.js:1935-1941`). A first-party worker earning subsidy would take a
slice of a pot whose entire purpose is bootstrapping *volunteers* — the treasury
paying itself, diluting every real machine, while the public stats page says the
network has N workers. That is self-dealing, and no amount of good intent
changes the arithmetic on a volunteer's payout.

So: **seed receipts contribute zero subsidy demand and mint zero subsidy.**

Mechanism: an operator-held allowlist on the scheduler (`KAI_SEED_ADDRS`),
checked in `_subsidyValueSat`. Authoritative — no client self-declaration, no
new protocol surface, and visible in config rather than hidden in behaviour.

Seed workers DO earn **paid** revenue, and should. Paid chat value never touches
the pool (`scheduler.js:1900-1901`); it is payment for compute actually
delivered, and it offsets the pod bill honestly.

Free-tier traffic served by a seed pod is therefore **Koinos AI's expense, paid
in cash, not minted**. That is precisely the intent: buying the network a
capability it cannot yet grow.

### 6.2 It has to be visible that we run it

"9 workers online" means something different if 3 are ours. A network that sells
itself as volunteer-powered cannot quietly be half first-party without saying
so — and the moment someone works it out from a wallet address, the honesty of
everything else we publish is in question.

- `/scheduler/network/status` marks seed workers.
- The public stats page separates **community** from **Koinos AI seed**
  capacity, and says why the seed exists.
- Seed workers are **excluded from the anti-Sybil shadow calibration**. Our own
  identical pods would collide with each other and poison the very dataset the
  ~Sep 2 gate decision is being calibrated on.

### 6.3 The blocker is the catalog, not the hardware

There is nothing above 32B to serve. Adding a 70B class needs, in order:

1. A rate-card entry in `MODEL_RATES` — inert until a worker advertises it, so
   this is safe to land early.
2. A catalog entry in `core/models/catalog.json` with a **real URL and
   sha256**. This cannot be fabricated and cannot be verified from here; it
   needs the actual artifact.
3. `minRamGb` set for the class (~48 for a 70B Q4).

Suggested rate, following the existing ladder (32B is $1.00/$4.00):
**70B at $2.00 / $8.00 per 1M.** Provisional — it is a price, and pricing is
the owner's call.

### 6.4 The cost, and the one hard problem

Using the §5 formula at the proposed 70B rate, revenue is `$0.0288 × T` per
hour. A 70B Q4 on an 80 GB card does order 15-20 tok/s, so **~$0.43-0.58/hour
at 100% utilisation** against a card costing roughly $1.50-2.00/hour.

> **An always-on 70B costs on the order of $1,200-1,500/month and recovers a
> minority of that even if it never idles.**

That is the number the decision turns on. It is a marketing and capability
budget, and should be approved as one.

**The hard problem is scale-to-zero, and it is structural.** The obvious
mitigation — only run the pod when there is demand — collides with how dispatch
works: a worker that is not running is not in the roster, so nothing routes to
it, so no demand ever appears, so it never starts. Chicken and egg.

The pieces to solve it already exist. `PREFER_WINDOW_MS` reserves a job for a
chosen worker, and `/worker/warming` already holds a lease open across an
announced engine swap. A "cold seed" that is advertised-but-asleep, woken on
first dispatch inside a warming grace, is the same shape. **Not built, not
designed in detail — but it is the difference between $1,400/month and paying
for what is used, so it deserves the design pass before any pod is rented.**

---

## 7. Recommendation

1. **DONE — VRAM in the advertise gate** (§1). Shipped with this doc; it was a
   standing bug on consumer hardware too (a 24 GB 4090 beside 16 GB of DDR4 was
   refused the classes it serves fastest).
2. **Land the 70B rate-card entry.** Inert until served; unblocks everything.
3. **Build seed-worker exclusion** (§6.1) BEFORE any first-party pod touches
   production. This is the integrity guarantee, and it is much easier to have
   in place than to retrofit after volunteers have been diluted.
4. **Design scale-to-zero** (§6.4) before renting anything always-on.
5. **Then** rent one pod, one class, and measure real utilisation for a fixed
   trial period against a stated budget cap.
6. Keep fingerprint out of the reputation formula (§1) — now doubly so, since
   our own pods would be its most obvious false positive.

## 8. Open questions for the owner

- **Budget and trial length?** One 70B pod is order $1,200-1,500/month
  always-on. What is the cap, and how long is the trial before it is judged?
- **Which model?** A 70B needs a real artifact (URL + sha256) that cannot be
  invented here. Llama 3.3 70B and Qwen 2.5 72B are the obvious candidates.
- **70B pricing** — $2.00/$8.00 per 1M is a suggestion following the ladder, not
  a recommendation. It is a market decision.
- **Is scale-to-zero worth building first**, or is a fixed-hours always-on pod
  (e.g. 12h/day) an acceptable v1 at roughly half the cost?
