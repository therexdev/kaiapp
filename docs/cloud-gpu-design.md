# Cloud GPU (RunPod and friends) — design exploration

**Status: exploration, nothing built. 2026-08-22.**
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

That asymmetry should drive what gets built and in what order.

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

## 2. Part A — using a big model yourself

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

## 6. What this is actually good for

Three uses survive the arithmetic:

1. **Burst capability for yourself.** $0.40/hr for a 32B-class model you switch
   off when you are done is cheap next to a $1,500 card, and needs no belief
   about token prices. This is the real offer.
2. **Seeding capacity deliberately.** Koinos AI running its own pods to give the
   network big-model classes it otherwise lacks — a marketing and capability
   expense, honestly booked as one, not dressed up as mining.
3. **Later, on real demand.** The break-even formula in §5 is the trigger. When
   sustained paid utilisation on the big classes clears it, this reopens on its
   own merits. Not before.

---

## 7. Recommendation

1. **Build A2** — remote model alongside local ones, opt-in per model, labelled
   at the point of selection, footer honest while active.
2. **Write the operator guide** for the network half, leading with the
   persistent-volume requirement and stating the economics plainly, including
   that it currently loses money. Better to say it than to have someone
   discover it with their own money.
3. **Fix the RAM gate** to consider VRAM — worth doing regardless, since it
   already misjudges consumer boxes with big GPUs and small RAM.
4. **Decide on fingerprint-vs-cloud before the gate arms (~Sep 2).** Recommend:
   keep fingerprint out of the reputation formula, where it already is. It is a
   diagnostic worth watching, and a poor discriminator against exactly the
   population that is hardest to distinguish.
5. **Do not** market cloud hosting as an earning opportunity at current rates.

## 8. Open questions for the owner

- Ship A2 only, or A2 plus an explicitly-labelled self-hosted A1?
- Does the catalog get a >32B class? Without one, the whole "bigger models"
  premise has nowhere to go.
- Fingerprint: confirm it stays out of the payout formula when the gate arms.
- Should Koinos AI itself run seed pods (§6.2)? That is a spend decision.
