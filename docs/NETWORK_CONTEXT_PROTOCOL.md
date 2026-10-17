# Network context capabilities — protocol 1

Shared contract between KoinosAI Core (this repo: worker, runtimes, gateway)
and the production scheduler (`therexdev/kai` `lib/scheduler.js`). Both PRs
implement exactly this document; neither works fully without the other, and
each stays compatible with the other's previous version.

Scope: KoinosAI Core/shared network only. No Koinos Router code, UI,
branding, config or dependencies. `server/scheduler.js` in this repo is a
retired fixture and is not changed. KOIN shadow/funded/mainnet lanes are
untouched. Larger context is not persistent sessions and adds no tools.

## 1. Constants (identical names and values in both repos)

```
CONTEXT_TIERS             = [4096, 16384, 32768]
OPT_IN_TIERS              = [16384, 32768]          // kaiapp only
LEGACY_CONTEXT_TOKENS     = 4096
LEGACY_MAX_TOKENS         = 512
NETWORK_MAX_OUTPUT_TOKENS = 4096
CONTEXT_PROTOCOL          = 1
CTX_HEADROOM_TOKENS       = 512                     // existing gateway constant
```

## 2. Known model windows (never inferred from RAM/VRAM)

kaiapp `core/models/catalog.json` packages gain `maxContextTokens`;
`contextSize` stays 4096:

| package | maxContextTokens |
|---|---|
| `qwen2.5-1.5b-instruct-q4_k_m@1` | 32768 |
| `llama-3.2-3b-instruct-q4_k_m@1` | 131072 |
| `qwen2.5-7b-instruct-q4_k_m@1` | 32768 |
| `google_gemma-3-4b-it-q4_k_m@1` | 131072 |
| `mistral-7b-instruct-v0.3-q4_k_m@1` | 32768 |
| `qwen2.5-coder-7b-instruct-q4_k_m@1` | 32768 |
| `meta-llama-3.1-8b-instruct-q4_k_m@1` | 131072 |
| `google_gemma-3-12b-it-q4_k_m@1` | 131072 |
| `qwen2.5-14b-instruct-q4_k_m@1` | 32768 |
| `phi-4-q4_k_m@1` | 16384 |
| `mistral-small-24b-instruct-2501-q4_k_m@1` | 32768 |
| `google_gemma-3-27b-it-q4_k_m@1` | 131072 |
| `qwen2.5-32b-instruct-q4_k_m@1` | 32768 |
| `qwen2.5-coder-32b-instruct-q4_k_m@1` | 32768 |
| `deepseek-r1-distill-qwen-32b-q4_k_m@1` | 131072 |
| `smollm2-135m-instruct-q8_0@1` | 8192 (dev-tiny, never configurable) |

kai `MODEL_RATES`: every class gains `maxCtxTokens = min(window, 32768)` —
32768 for every class except `phi-4` (16384). `ctxTokens: 4096` is unchanged.

## 3. Estimators (byte-identical code in kaiapp `core/lib/context-terms.js` and kai `lib/scheduler.js`)

```js
// LEGACY: exact copy of today's gateway estimateMessageTokens (UTF-16 .length)
function estimateTokensLegacy(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0, n = 0, images = 0;
  for (const m of messages) {
    n += 1;
    const c = m?.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === "image_url") images += 1;
        else chars += String(part?.text ?? "").length;
      }
    } else chars += String(c ?? "").length;
  }
  return Math.ceil(chars / 4) + n * 4 + images * 800;
}
// V1: content only (no role/name); code points via for..of; ONE global ceil.
function estimateTokensV1(messages) {
  if (!Array.isArray(messages)) return 0;
  let ascii = 0, other = 0, n = 0, images = 0;
  const count = (s) => { for (const ch of s) { if (ch.codePointAt(0) < 128) ascii += 1; else other += 1; } };
  for (const m of messages) {
    n += 1;
    const c = m?.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === "image_url") images += 1;
        else count(String(part?.text ?? ""));
      }
    } else count(String(c ?? ""));
  }
  return Math.ceil(ascii / 4) + other + n * 4 + images * 800;
}
const tierFor = (required) => CONTEXT_TIERS.find((t) => required <= t) ?? null;
```

Property (tested in kaiapp): `estimateTokensV1(m) >= estimateTokensLegacy(m)`.

## 4. Worker opt-in config (kaiapp Core)

- Settings key `runtime.modelContext` =
  `{ [alias]: { contextTokens: 16384|32768, maxOutputTokens?: int } }`.
  Missing entry = legacy.
- `maxOutputTokens` defaults to 512; integer in
  [512, min(4096, contextTokens/2)].
- Allowed only for catalog aliases that are not custom, not dev, and whose
  package `maxContextTokens >= contextTokens`. Stored settings are
  re-validated against the catalog on every read; invalid entries are
  dropped. Never auto-enabled; never derived from RAM/VRAM.
- `GET/POST /core/runtime/context` behind the same `_sameSite` +
  `_coreAuthed` gates as `/core/network/config`. POST with `contextTokens`
  null or 4096 clears the entry. POST clears the alias's session-failed and
  verified markers and never loads a model by itself. No desktop UI in this
  slice.

## 5. Engine parity and verification (kaiapp)

**Legacy launch.** With no opt-in, llama.cpp args, Ollama model name and
Ollama create bodies are byte-identical to today.

**llama.cpp opt-in N.** Launch with `--ctx-size N --parallel 1`
(`--parallel 1` after the `--n-gpu-layers` pair, before extraArgs). b10423
defaults `--parallel` to auto, so `--ctx-size` alone does not prove the
per-request window. After health, `GET /props` (3s timeout, up to 3 attempts
with a short backoff). Verified iff
`Number.isSafeInteger(default_generation_settings.n_ctx) && n_ctx >= N &&
(total_slots == null || total_slots === 1)`.
`--parallel 1` means an opted-in alias serves one request at a time (local
chat and network jobs queue behind each other); `GET /core/runtime/context`
reports `parallel: 1` for opted-in aliases.

**Ollama opt-in N.** Model name `koinos-<alias>-ctx<N>`; create body
`{model, files, parameters: {num_ctx: N}}`; fallback modelfile
`FROM <path>\nPARAMETER num_ctx N`. `/api/show` reporting `num_ctx` is only
a configuration precheck (recreate once on mismatch) and is NEVER sufficient
for verification. Verified iff, after a bounded local warm-up
(`POST /api/generate {model, prompt: "", stream: false}` with a timeout),
`GET /api/ps` lists the model (match `name` or `model`, with or without
`:latest`) with `Number.isSafeInteger(context_length) && context_length >= N`.
A missing entry, a missing/smaller `context_length`, or any timeout is
unverified (fail closed).

**Unverified.** The engine keeps serving locally, the alias is advertised
at legacy 4096/512, and `runtime:context` is emitted with `verified:false`.

**Opt-in start throws.** Stop the runtime, add `alias@N` to the
session-failed set, AWAIT the opt-in child's exit (bounded, ~10s) so it has
released device memory, emit `runtime:context-fallback`, and retry once at
legacy on the SAME rung with a fresh runtime and byte-identical legacy opts.
The opt-in failure never writes badBuilds and never sets `_llamaDead`. A
failure of that immediate legacy retry is tagged (`afterOptIn`) and also
skips the badBuilds write and `_llamaDead`/self-test classification while
still falling through the ladder; the next load (opt-in now session-failed)
runs the plain legacy path and records genuinely bad builds exactly as today.

**Advertisement and reloads.** An alias advertises `{N, configured
maxOutputTokens}` only if N was verified this session for the currently
configured tier; otherwise `{4096, 512}`. A change in the verified set
re-registers the worker (single-flight plus a dirty flag). `ensure()` and
`acquireFor()` share one predicate: `_serving(alias) = activeAlias===alias
&& running && _loadedCtx === _desiredCtx(alias)` (`_loadedCtx` is the
requested tier, or null for legacy; `_desiredCtx` returns null once
`alias@tier` is session-failed, so there is no reload loop). Reloads use the
existing drain/hold path.

**Per-request verification.** Before any job or request with non-legacy
terms runs, after the runtime hold is acquired, the engine is re-probed
(llama.cpp `/props`, Ollama `/api/ps`; bounded, READ-ONLY) and must report
a per-request window `>=` the job's `contextTokens`. The per-request check
never warms up or loads anything (never `POST /api/generate`); the single
bounded warm-up happens only during the initial opt-in load. An Ollama
runner that is unloaded, missing from `/api/ps`, or too small fails closed:
the job is refused (no inference), the alias is marked unverified and
re-advertised at legacy, with no implicit reload. (Consequence: after
Ollama's idle unload, an opted-in alias advertises legacy until its next
opt-in load.)

## 6. Registration and scheduler sanitizer

Updated workers add to the register body
`context: { protocol: 1, models: { [alias]: { contextTokens, maxOutputTokens } } }`
with one entry per advertised (`models`) alias (verified opt-in value or
`{4096, 512}`). Custom and dev aliases never appear. Old workers send no
`context`.

Scheduler `sanitizeWorkerContext(raw, models)` (`models` = server-filtered):

```
if raw is not a plain object, or raw.protocol !== 1 (strict number) -> null (LEGACY worker)
src = plain-object raw.models, else {}
for each m in models (own properties only; nothing else copied):
  e = own src[m] or null
  maxCtx = own MODEL_RATES[m] ? (MODEL_RATES[m].maxCtxTokens || 4096) : 4096
  ctx = (e && Number.isSafeInteger(e.contextTokens) && CONTEXT_TIERS.includes(e.contextTokens) && e.contextTokens <= maxCtx) ? e.contextTokens : 4096
  out = 512
  if (ctx > 4096 && e && Number.isSafeInteger(e.maxOutputTokens)) out = min(max(e.maxOutputTokens, 512), min(4096, ctx/2))
  result.models[m] = { contextTokens: ctx, maxOutputTokens: out }
return { protocol: 1, models: result.models }
```

Runs on every `/worker/register` (never carried over: a re-register without
`context` is legacy) and again on roster load. `_capacityOf(w, m) =
w.context?.protocol === 1 ? (w.context.models[m] || LEGACY_CAP) : LEGACY_CAP`
with `LEGACY_CAP = {contextTokens: 4096, maxOutputTokens: 512}`.
Class names are checked with `Object.hasOwn(MODEL_RATES, m)` everywhere
(register filter, roster-load re-filter, sanitizer, `/pricing` lookups on the
client); the sanitized `models` map never gains `__proto__`/`constructor`.

## 7. Consume lanes (`POST /consume/chat/completions`)

**Lane split** (unchanged): grant lane iff `!b.signature && (b.sessionToken
|| b.grantId)`. The grant lane ignores `signatureVersion`.

**Wallet lane signature selection:** `b.signatureVersion == null` → legacy;
`=== 1` (number) → v1; anything else → 400 `unsupported_signature_version`.

**Legacy signed hash** (unchanged):
`sha256(utf8("consume|" + address + "|" + ts + "|" + JSON.stringify(messages)))`.

**v1 signed hash:**
`sha256(utf8("consume-v1|" + JSON.stringify([address, ts, model, max_tokens, messages])))`.
`ts` and `max_tokens` are JSON numbers; `model` is the exact string sent (a
class or `"auto"`). Signature encoding as today (base64 koilib recoverable).
Shape checks BEFORE verification (400 `invalid_terms` / `invalid_max_tokens`):
`typeof ts === 'number' && Number.isSafeInteger(ts)`; `typeof model ===
'string' && (model === 'auto' || own MODEL_RATES[model])`; `typeof
max_tokens === 'number' && Number.isSafeInteger(max_tokens) && 1 <=
max_tokens <= 4096` (no `maxTokens` alias).
v1 messages must also be plain TEXT role/content turns (tools and images
stay off the larger-context lane): every message is a plain object whose
keys are a subset of `{role, content}`, `role` is `system`, `user` or
`assistant`, and `content` is a string or an array of parts each of which
has EXACTLY the keys `{type, text}` with `type === "text"` and `text` a
string; anything else (image parts, extra part keys, nested tool fields) is
400 `invalid_terms`. Images are excluded because a flat per-image estimate
cannot give accurate capacity refusals. The legacy lane, including its
multimodal path, is unchanged.

v1 carries no unsigned billing switches: `selfHost` is not part of the v1
signed tuple, so on the v1 lane any `b.selfHost` other than absent/`false`
is refused with 400 `invalid_terms` (before verification, nothing charged).
Own-machine requests keep using the legacy wallet lane and the grant lane
exactly as today. Binding `selfHost` into a future signed tuple is a
follow-up.

Both wallet lanes: same 120s window, per-wallet lock, and replay guard —
after a successful recover, 401 if EITHER `_signatureReplayed(String(b.signature), ts)`
OR `_signatureReplayed("m:" + hashHex, ts)` (closes the base64
whitespace/re-encoding bypass of today's string-keyed guard).

**Terms per lane:**

- **Legacy wallet lane.** `raw = b.max_tokens ?? b.maxTokens`; if present
  (null/undefined = absent) and not `Number.isSafeInteger(raw) && raw >= 1`
  → 400 `invalid_max_tokens`. `estimateTokensLegacy(messages) > 4096` → 400
  `context_length_exceeded` (prompts that fit but leave < 512 output are not
  refused, matching today). Terms `{maxTokens: min(raw ?? 512, 512),
  contextTokens: 4096}` — so existing callers sending 900 are served at 512.
- **Grant lane.** Existing max_tokens 400s unchanged; NEW
  `estimateTokensLegacy > 4096` → 400 `context_length_exceeded` after the
  ceiling check and BEFORE the rate/hold. Terms `{maxTokens: min(wantTok,
  512), contextTokens: 4096}`. No larger terms on this lane.
- **v1 lane.** `est = estimateTokensV1(messages)`; `required = est +
  max_tokens`; `required > 32768`, or `> maxCtxTokens` for a named class →
  400 `context_length_exceeded`. Terms `{maxTokens: max_tokens,
  contextTokens: tierFor(required), termsVersion: 1}`. Never downgraded.

**Handler order** (legacy positions unchanged): 1) 400 messages; 2) lane
split, grant 401/403/404, wallet 401 missing fields; 3) signatureVersion and
v1 shape 400s (incl. v1 `selfHost`); 4) 401 stale ts; 5) 401 recover/mismatch; 6) 401 replay;
7) 409 wallet lock, `try {`; 8) per-lane terms 400s (grant: existing 400s,
new prompt 400, then existing hold/402); 9) `_syncDeposits`,
`_consumeCapacity`, existing 402 zero gate; 10) model resolution — legacy
and grant exactly as today, v1 capacity-aware (§8) → 503
`insufficient_capacity`; 11) selfHost 409 via `_canServe(x, {model,
...terms})`; 12) v1 and not selfServed: worst-case affordability → 402
(`type: insufficient_quota`, `code: worst_case_unaffordable`); 13)
`enqueue({type:'chat', cu:1, messages, model, ...terms, ...selfServed})`.

Every NEW terms/capacity refusal happens before any grant hold, charge,
enqueue or dispatch. Error codes are additive `error.code` fields; existing
`type` values and messages are unchanged. The context-length message is
actionable ("too long for the network's N-token context — shorten it or
start a new chat").

## 8. Routing, auto, selfHost, worst case

`_canServe(w, job)`: existing forWorker/preferWorker gates; existing
models/legacy dev-tiny rule; if `job.termsVersion === 1 && w.context?.protocol
!== 1` → false; if the job carries contextTokens or maxTokens:
`cap = _capacityOf(w, job.model)` and require `(job.contextTokens||4096) <=
cap.contextTokens && (job.maxTokens||0) <= cap.maxOutputTokens`. Legacy-term
jobs `{<=512, 4096}` pass every worker that holds the model.

Own-machine (`selfServed`) jobs are never offered to another address: on
lease expiry `_reapPending` requeues them with their `forWorker` stamp kept
(no seed/mystery credit changes), and when queue hygiene finds their target
no longer live it drops the job and resolves its waiting consumer as a
failure (no result, no charge) instead of releasing the stamp. Eval and
mystery stamp rescue are unchanged. (This also fixes the pre-existing
legacy behaviour where an expired own-machine job could be served, unpaid,
by another worker that would see its private messages.)

v1 `auto`: classes by `outMicroPerM` descending (stable) with
`(maxCtxTokens||4096) >= required`; first class served by a HEALTHY live
worker passing `_canServe(x, {model, ...terms})`, else any live worker, else
503 `insufficient_capacity`. Named v1 class: any live worker must pass, else
503. `_preferredFor` accepts a string (legacy callers) or a job and probes
`{model, termsVersion, contextTokens, maxTokens}` only.

Worst case (v1, not selfServed):

```
promptBound = min(24 + Buffer.byteLength(JSON.stringify(messages), "utf8"), terms.contextTokens)  // exactly what /worker/result can bill
worstTok = promptBound + max_tokens; worstMicro = usageCostMicro({prompt_tokens: promptBound, completion_tokens: max_tokens}, model)
free = max(0, cap.freeTokensLeft)
if (free < worstTok) {
  uncovered = BigInt(Math.ceil(worstMicro * (worstTok - free) / worstTok))
  spendable = max(0n, cap.balanceMicro) + (price.satPerMicro > 0n && cap.earningsLeftSat > 0n ? cap.earningsLeftSat / price.satPerMicro : 0n)
  if (uncovered > spendable) -> 402
}
```

The gate reserves what it authorises, and the reservation is honoured at
actual BILLING on every lane, not just at authorisation (a gate-only
reservation still lets whichever request finishes first spend the reserved
free allowance). While a v1 request is in flight it holds an in-memory
reservation `{id, address, ip, freeTok: min(free, worstTok), uncoveredMicro}`:

- Free pools: every lane's authorisation (`_consumeCapacity`, the v1 gate)
  and every lane's billing (`_chargeUsage`) computes the per-address,
  per-IP and global free pools minus all OTHER in-flight v1 reservations
  (min of the three, as `_freeTokensLeft`). The owner bills against the
  pools minus others' reservations, so its own reserved tokens remain
  available to it and to nobody else. A legacy or grant request therefore
  cannot consume reserved free tokens; if nothing else covers it, its own
  existing gate refuses it (402) as today.
- Money on the same address: wallet-lane requests are already serialised
  by the per-wallet lock. While a v1 reservation with `uncoveredMicro > 0`
  is in flight on an address, a grant-lane request for that address is
  refused 409 (existing "an earlier request for this wallet is still
  running" message), and a v1 request is refused 409 while a grant-lane
  request for its address is in flight, so no other lane can spend the
  money the v1 gate counted on.
- Release exactly once: the owner's reservation is deleted in the same
  synchronous block as its `_chargeUsage` (no await between), or in the
  handler's `finally` when the request ends without a charge (refused,
  timed out, disconnected, self-served). Reservations never persist.

Required regressions: funded B finishes first (zero-balance A's v1 reserves
the shared IP free pool; funded B's v1 is accepted and finishes first; B's
billing does not use A's reserved tokens; A is then billed from free with no
debt); overlapping legacy finishes first (A's v1 reservation; another
wallet's legacy request on the same IP finishes first without using A's
reserved tokens — refused 402 when nothing else covers it; A billed with no
debt); two zero-balance wallets racing one shared pool (second refused 402
before dispatch); grant/v1 same-address 409s; the reservation map is empty
after served, refused, timed-out, disconnected and self-served endings.
Legacy engine/context behaviour is unchanged; only the availability of
reserved free tokens is respected.

## 9. Job payload

`enqueue` sanitizes: chat jobs always carry `maxTokens` (clampInt 1..4096,
default 512) and `contextTokens` (in CONTEXT_TIERS, else 4096);
`termsVersion` kept only if `=== 1`; evals carry none of these;
`/operator/enqueue` goes through the same sanitization.

Visible chat job fields: `id, type, model, modelClass, prompt, messages,
createdAt, maxTokens, contextTokens` (+ `selfServed` as today). Stripped in
give(): `challenge, challengeTier, forWorker, preferWorker, preferUntil,
termsVersion`.

Mystery chats: legacy targets get `{512, 4096}`; a protocol-1 target whose
capacity exceeds legacy gets v1-like terms with probability
`KAI_MYSTERY_V1_SHARE` (NaN-guarded, default 0.5): terms are drawn from a
bounded ring buffer (last 64) of real v1 consumer terms filtered to the
target's `_capacityOf`, falling back to `maxTokens` from [1024, 2048, 4096]
filtered to `<= cap.maxOutputTokens`; `termsVersion: 1`. When the drawn
`contextTokens > 4096`, a deterministic generated filler document is added so
that `estimateTokensV1(messages) + maxTokens` lands in
`(previous tier, contextTokens]`, with the answer-bearing fact at the START
(a tail-truncating or 4K engine then fails the shadow challenge). Otherwise
`contextTokens = tierFor(estimateTokensV1(messages) + maxTokens)`. Shadow
tier 0, the per-epoch cap and the visible key set (identical to a consumer
chat job's) are unchanged.
The ring records a v1 job's terms only after an accepted, billed
`/worker/result` (never at enqueue, never self-served), with at most 4
entries per consumer address; and with a fixed probability (0.25) the
mystery uses the target's own advertised maximum (`cap.contextTokens` with
filler, `cap.maxOutputTokens`) regardless of the ring, so claimed capacity
is always audited.

## 10. Result billing (`/worker/result`)

After the existing byte caps:
- for `job.termsVersion === 1`, `usage.completion_tokens =
  min(usage.completion_tokens, job.maxTokens)` BEFORE `clamped` is computed
  (counts as a clamp; the self-served no-strike rule still applies);
- for EVERY chat job, `usage.prompt_tokens = min(usage.prompt_tokens,
  job.contextTokens || 4096)` AFTER `clamped` (billing-only: no strike, no
  clamp event). A legacy request that an opted-in engine happens to process
  beyond 4096 tokens is therefore never billed beyond legacy terms.

Receipt shape unchanged. Updated workers report `completion_tokens =
min(reported, max_tokens sent)`.

## 11. Worker execution (kaiapp)

Normalize: `mt = Number.isSafeInteger(job.maxTokens) && 1 <= mt <= 4096 ?
job.maxTokens : 512`; `ctx = CONTEXT_TIERS.includes(job.contextTokens) ?
job.contextTokens : 4096`; garbage degrades to legacy, never throws.

Legacy terms (`ctx <= 4096 && mt <= 512`): today's path with `max_tokens =
mt`; evals use 128.

The `/worker/warming` notice also fires when the job's alias is resident
but must be reloaded at a different context (`runtime.isServing(alias)
=== false`), so a same-alias context reload gets the existing one-time
lease grace.

Non-legacy terms: BEFORE acquireFor refuse (throw, no inference) if `ctx >
adv.contextTokens || mt > adv.maxOutputTokens` (`adv =
runtime.advertisedContext(job.model)`); AFTER the hold require the live
per-request probe of §5 to report `>= ctx` and `mt <=` the configured
maxOutputTokens; the hold is released in the existing finally. Any refusal
emits `worker:terms-refused` and re-advertises. Single runtime hold,
streaming, cancellation and lease behaviour are unchanged.

Cancellation for non-legacy jobs: each such job gets an AbortController
passed to the engine fetch; it aborts when a `/worker/chunk` POST answers
404 with a JSON `ok:false` body (the scheduler's "unknown job": consumer
gone, or lease moved). 401s and network errors do not abort. The hold is
still released in `_execute`'s finally and no result is posted. Prefill
before the first chunk cannot be cancelled. Legacy-term jobs keep today's
behaviour.

## 12. Discovery

`/pricing`: each model adds `maxCtxTokens: r.maxCtxTokens || 4096`
(`ctxTokens` unchanged); top level adds `context: {protocol: 1, tiers:
[4096,16384,32768], legacyCtxTokens: 4096, legacyMaxTokens: 512,
maxOutputTokens: 4096}`.

`/network/models`: each model adds `ctxTokensMax` and `maxOutputTokensMax`
(max over live providers of `_capacityOf`; 4096/512 with only legacy
providers). Independent upper bounds; the 503 is authoritative.
`/network/roster` untouched.

## 13. Client lane selection (kaiapp gateway `_chatNetwork` and overflow)

Larger OUTPUT is an explicit caller opt-in; longer PROMPTS may negotiate
signed larger context automatically.

Inputs:
- `mt = body.max_tokens`; null/undefined = absent; otherwise must satisfy
  `Number.isSafeInteger(mt) && mt >= 1`, else 400 before signing/fetching.
- `extended = body.kai_extended_output === true` (strict boolean; the
  explicit opt-in for network output above 512, following the existing
  `kai_private_desktop` convention).
- `rates = _networkRates(class)`; `classMax` = exact class entry's
  `maxCtxTokens` read via `Object.hasOwn` (`auto` = max over the table;
  unknown class = null).
- `proto` = `/pricing` `context` iff `protocol === 1 && Array.isArray(tiers)`.
  Negotiation is bounded locally: only tiers in the local `CONTEXT_TIERS`
  are accepted (others ignored; none left => no proto), `maxOutputTokens`
  is honoured only as an integer in [512, 4096], and a class
  `maxCtxTokens` is honoured only as a safe integer, clamped to
  `min(value, 32768)`; malformed values fall back to legacy. Malformed or
  oversized `/pricing` can never authorise a larger prompt or output than
  this contract allows.
- `legacyOk = estimateTokensLegacy(messages) <= rates.ctxTokens - 512`
  (today's gate).
- `limit = min(classMax, max(proto.tiers))`.

Lane choice:
- **Not extended, or `(mt ?? 0) <= 512`** (output stays legacy-capped,
  `out = min(mt ?? 512, 512)`):
  - `legacyOk` → legacy lane, today's signature, forward `max_tokens: mt`
    when present (the scheduler serves it at <= 512). Existing callers that
    send 900/1200/1500/4096 keep working with default workers.
  - `!legacyOk && proto && classMax` → v1 with `max_tokens = out`;
    `estimateTokensV1 + out > limit` → local 400.
  - otherwise → today's 400.
- **Extended and `mt > 512`:** requires `proto && classMax`, else local 400
  ("this network does not offer extended output"); `mt >
  proto.maxOutputTokens` → local 400; `estimateTokensV1 + mt > limit` →
  local 400; else v1 with `max_tokens = mt`.

v1 is used only when the caller explicitly targets the network
(`koinos-network` / `koinos-network:CLASS`). Automatic local→network
overflow (context or capability miss) NEVER upgrades to v1: it keeps
today's legacy-lane semantics and today's refusal when the prompt does not
fit legacy, so nothing new leaves the machine for users who opted into
nothing. An explicitly extended request (`kai_extended_output: true`,
`max_tokens > 512`) that falls into automatic overflow is refused locally
(400 `extended_output_unavailable`) rather than served at 512 — it is never
silently downgraded. On the v1 lane the client sends messages mapped to `{role,
content}` and refuses locally (400) when they do not meet the §7 v1 shape
(e.g. tool turns).

Client half of the unsigned-switch rule: on the v1 path the gateway
refuses locally with 400 `invalid_terms` — before signing, with no consume
request and no charge — whenever `body.selfHost` is anything other than
`undefined` or `false` (so `true`, `null`, `0` and the string `"false"` are
all refused); it never drops the flag and sends a paid public request in
its place. `selfHost` absent or `false` works as before; the legacy gateway
path is unchanged.

Responses: a v1 503 (`insufficient_capacity` or otherwise) is returned to
the caller as a failure — no charge occurred — and is NEVER retried at a
smaller output or on the legacy lane. A v1 401 clears the `/pricing` cache
(`this._rates = null`) and fails without retry. KOIN rehearsal branch stays
first; privacy gates (local-only, private desktop, grounded) and API-key
budget checks are unchanged on the legacy lane. On the v1 lane, a metered
API key is additionally refused (429 `insufficient_quota`) before signing
when the v1 worst case — prompt `min(24 + utf8 bytes of
JSON.stringify(messages), tierFor(estimateTokensV1 + max_tokens))` plus
`max_tokens` output at the class's published rates — exceeds its
remaining monthly network budget.
For `auto` the v1 worst case is priced at the MAXIMUM published input and
output rates over the classes eligible for the request (classes whose
bounded `maxCtxTokens` fits the requirement; or all classes), never at the
first/Fast class that `_networkRates` uses for legacy estimates; a named
class uses its own rates. Non-finite or negative published rates fail
closed (local 429/400, no signing, no consume request). The legacy
estimator and price behaviour are unchanged.

Caller-disconnect cancellation (v1 lane): the gateway creates an
AbortController, registers `res.on('close')` BEFORE the scheduler fetch,
combines it with the existing 190s deadline (`AbortSignal.any`), removes
the listener in `finally`, and never writes once `res.destroyed`. A local
Stop therefore closes the scheduler stream, the scheduler drops the job
(no result, no charge), the worker's next chunk gets 404 and aborts the
engine request, and the hold is released. Legacy-lane behaviour may stay
as today.

## 14. Compatibility guarantees

- Old kaiapp clients (no max_tokens, legacy signature) get jobs `{512, 4096}`.
- Old workers (no `context`) receive only legacy-term jobs.
- New workers without an opt-in advertise `{4096, 512}` and behave exactly
  as today on legacy terms.
- The kai web app (grant lane, max_tokens 1024) gets jobs with maxTokens 512.
- Existing Core callers sending `max_tokens` 900 (ui/app.js, ui/mascot.js,
  cli/koinos-code.js) or 1200/1500 are served on the legacy lane at 512.
- Legacy launch args, Ollama names and create bodies are byte-identical.
- New clients send v1 only to schedulers whose `/pricing` advertises
  `context.protocol === 1`.

## 15. Required regressions (beyond unit coverage)

- An existing 900-token caller against the new scheduler with only default
  workers succeeds at the 512 cap (kaiapp e2e against the real kai scheduler,
  and a kai probe on the legacy lane).
- An explicitly extended request is never silently downgraded and fails
  without charge when no capable worker exists (kaiapp gateway test + e2e).
- An Ollama runner configured large but effective small (`/api/ps`
  `context_length` below N, or missing) is never advertised.
- A legacy job served by an opted-in `{32768, 4096}` worker that reports
  prompt_tokens 12000 is billed at most 4096 prompt tokens, with no strike
  and an unchanged clamp counter.
- An opt-in load failure followed by a failing immediate legacy retry
  (e.g. `exit code 3221226505`) writes no badBuilds and sets no
  `_llamaDead`; a later plain legacy hard crash records badBuilds as today.
- A chunk 404 aborts a non-legacy job's engine request and releases the
  hold; a 401 does not abort.
- A Local-First request on a non-opted-in local alias whose prompt
  (estimate ~6000) does not fit is refused as today — no signing, no fetch,
  no v1 overflow.
- A v1 request carrying tool turns or extra message keys is refused (client
  local 400; scheduler 400 `invalid_terms`).
- A v1 request carrying an `image_url` part, or a text part with an extra
  key, is refused (client local 400 or legacy lane when it fits; scheduler
  400 `invalid_terms`).
- Ollama verification: the initial opt-in warm-up runs exactly once per
  load; per-request checks never `POST /api/generate`; an unloaded,
  missing or too-small runner fails closed with no implicit reload.
- Caller disconnect on a v1 stream (gateway → real scheduler → worker →
  fake engine): the caller closes after the first delta; the upstream
  abort propagates; the worker's engine request is aborted and its hold
  released; no result is accepted and nothing is charged.
- Malformed or oversized `/pricing` (`tiers` with 65536 or junk,
  `maxCtxTokens` 1e9 / "32768" / negative, `maxOutputTokens` 99999) never
  authorises more than the contract tiers/ceilings.
- v1 with `selfHost: true` (or any non-false value) → 400 `invalid_terms`,
  nothing charged; flipping `selfHost` on a captured v1 request is refused
  or verifies only as the non-own-machine request it was signed as.
- Gateway v1 path with `body.selfHost` = `true` / `null` / `0` / `"false"`
  → local 400 `invalid_terms`: no signing, no consume request, no charge;
  absent or `false` → served as before; legacy gateway path unchanged.
- Metered v1 `auto` with a table of a cheap Fast class and an expensive 32B
  class, and a remaining key budget between the two worst cases → local
  429, no signing, no consume request; a named class uses its own price;
  a malformed (NaN/negative/non-numeric) published price never yields a
  billable v1 request.
- An own-machine job whose lease expires stays stamped to its owner; a
  second capable worker that registers afterwards can neither take the job
  nor receive its messages; when the owner's worker leaves, the job is
  dropped and the consumer gets a failure with no charge. Eval/mystery
  rescue behaviour is unchanged.
- `constructor`/`__proto__` class names never reach `w.models` or the
  sanitized map.
- Mixed capacities, legacy fallback, invalid limits, signature tampering and
  replay, insufficient capacity, runtime config validation.

## 16. Shared test vectors

Estimators `[messages] -> legacy / v1`:
- `[]` → 0 / 0; `null` → 0 / 0; `"hello"` → 0 / 0
- `[{role:"user",content:"abcd"}]` → 5 / 5; `"abcde"` → 6 / 6; `"héllo"` → 6 / 6
- `"你好世界"` → 5 / 8; `"😀"` → 5 / 5; `"\ud800"` → 5 / 5
- content `null` → 4 / 4; `12345` → 6 / 6; `{}` → 8 / 8; `[null]` → 4 / 4
- parts `[{type:"text",text:"abcdefgh"},{type:"image_url",...}]` → 806 / 806
- parts `[{type:"input_audio",...}]` → 4 / 4
- `[{content:"a"},{content:"b"}]` → 9 / 9 (one global ceil; per-string ceil would give 10)
- `[{role:"system",content:"You are helpful."},{role:"user",content:"Hi 👋 你好"}]` → 14 / 16
- `"a".repeat(14320)` → 3584 / 3584 (client legacy gate OK); `14321` → 3585 / 3585
- `"a".repeat(16368)` → 4096 / 4096 (scheduler legacy 400 not refused); `16369` → 4097 / 4097 (refused)
- `"你".repeat(4000)` → 1004 / 4004; `"a".repeat(23984)` → 6000 / 6000

`tierFor`: 1→4096; 4096→4096; 4097→16384; 16384→16384; 16385→32768;
32768→32768; 32769→null.

v1 terms: est 6000 + 2048 → 8048 → 16384; est 4096 + 1 → 16384; required
32768 → 32768; 32769 → 400; phi-4 required 16385 → 400, 16384 → 16384;
max_tokens 0 / 4097 / 1.5 / "100" / missing → 400 `invalid_max_tokens`; ts
as a string → 400 `invalid_terms`.

Signed strings (fixed test key, never a real wallet):
- privateKeyHex = sha256("koinos-context-test-vector-v1") =
  `1545f7f0b715b40669d106f723a7da16ae7d8e03d6ec59d22c483262cef297df`;
  address `1E94BGncyzPvqHnUBPZaTk31XUxgnj3wEH`; ts `1767225600000`;
  model `koinos-fast`; max_tokens `2048`;
  messages `[{"role":"system","content":"You are helpful."},{"role":"user","content":"Hi 👋 你好"}]`
- v1 preimage (174 UTF-8 bytes):
  `consume-v1|["1E94BGncyzPvqHnUBPZaTk31XUxgnj3wEH",1767225600000,"koinos-fast",2048,[{"role":"system","content":"You are helpful."},{"role":"user","content":"Hi 👋 你好"}]]`
- v1 sha256 `3144f8fc12e66306f1b7d6658272d712acf366b54237c1af8b2787e6180b2754`
- v1 signature (deterministic)
  `IEZ75BHUy1ghVBRNROlGQ5uDcEkful/SWoCiu+sLZvXhZfVzZnO18cocBtJGfcDZ6bRO8DS/5Q1zPZYZPUPj7w4=`
- replay key `m:3144f8fc12e66306f1b7d6658272d712acf366b54237c1af8b2787e6180b2754`
- tamper: same tuple with max_tokens 4096 hashes to
  `f02f26b1c8bb755272a086fb56fdfbc45ef8559674d0494c165f8d20e4e3eb57`; the
  signature above does not recover to the address → 401
- whitespace replay: `sig + " \n"` decodes to the same bytes; the string key
  differs, the `m:` key matches → 401
- auto: `consume-v1|["1E94BGncyzPvqHnUBPZaTk31XUxgnj3wEH",1767225600000,"auto",512,[{"role":"user","content":"hello"}]]`
  → sha256 `b205160c9892d3cbddd1b3c32bbe00b34bc302987aeac9708d9ca21c2d5c413b`
- legacy (unchanged):
  `consume|1E94BGncyzPvqHnUBPZaTk31XUxgnj3wEH|1767225600000|[{"role":"system","content":"You are helpful."},{"role":"user","content":"Hi 👋 你好"}]`
  → sha256 `967f427649ca218bc2c90f759b8093c89ecdde0719a8e5da447c059d60d9243d`;
  signature `IMH11B8VVxXj1N4E3X3rpb7uYjwBNqgDHKPzxFRPugf3A78rsgAI5dW0E9UaTgXRuI8r4adAqP0+/J1s8S7yCls=`

Sanitizer (server-filtered `["koinos-fast","phi-4","koinos-smart"]`):
`undefined` / `{protocol:"1"}` / `{protocol:2}` / `[]` → null (legacy);
`{protocol:1}` → all `{4096,512}`; koinos-fast `{16384,2048}` →
`{16384,2048}`; `{8192,2048}` → `{4096,512}`; `{4096,2048}` → `{4096,512}`;
`{32768,100}` → `{32768,512}`; `{32768,"2048"}` → `{32768,512}`;
`{16384,1.5}` → `{16384,512}`; `{16384,1e9}` → `{16384,4096}`; phi-4
`{32768,4096}` → `{4096,512}`; phi-4 `{16384,9999}` → `{16384,4096}`; an
entry for an unlisted class → absent; `__proto__`/`constructor` keys
ignored; koinos-smart with no entry → `{4096,512}`.

Capacity predicate (A legacy; B P1 koinos-fast `{16384,2048}`; C P1
`{32768,4096}`; D P1 no opt-in `{4096,512}`): `{512,4096}` → A,B,C,D;
`{512,4096,tv1}` → B,C,D; `{1024,16384,tv1}` → B,C; `{512,32768,tv1}` → C;
`{3000,4096,tv1}` → C; `{64,4096}` legacy-lane job → A,B,C,D.

Worst case (µ$/M: koinos-fast 100000/400000; qwen25-32b 1000000/4000000;
phi-4 500000/2000000): koinos-fast est 6000 + 2048, free 0 → 1420; free 4024
→ 710; free 8048 → 0. qwen25-32b est 20000 + 4096, free 0 → 36384; free 1000
→ 34875. phi-4 est 12000 + 512 → 7024.

Client lane selection for explicit `koinos-network[:CLASS]` requests
(protocol-1 `/pricing`, koinos-fast maxCtxTokens 32768, ctxTokens 4096);
automatic overflow always uses the legacy rules:
- short prompt, no max_tokens → legacy, no max_tokens field
- short prompt, max_tokens 256 → legacy, 256 forwarded (job 256)
- short prompt, max_tokens 900 or 1024, no opt-in → legacy, forwarded (job 512)
- short prompt, max_tokens 1024, `kai_extended_output: true` → v1 1024 (tier
  4096); a 503 fails without charge and without any retry
- `"a".repeat(14321)` (legacy 3585), no max_tokens → v1 max_tokens 512,
  required 4097 → tier 16384
- `"你".repeat(4000)` (legacy 1004, v1 4004), no max_tokens → legacy
- max_tokens 9000 with opt-in → local 400 (above 4096; never capped down);
  without opt-in → legacy (job 512)
- max_tokens 0 / -1 / 1.5 / "64" → local 400, no sign or fetch; null → absent
- `/pricing` without `context` → always legacy; extended opt-in → local 400
- custom or unknown class → legacy lane; extended opt-in → local 400

## 17. Rollout gates (not done here)

- No hardware benchmarks were run. Prefill/generation time, memory headroom
  and thermal behaviour at 16K/32K are unmeasured on real participant
  hardware. Larger context stays off until an owner configures it per model
  on a machine they have measured.
- The consumer 180s timer and 300s chat lease bound slow large prefill;
  measure before enabling 32K on CPU-only machines.
- `--parallel 1` on opted-in llama.cpp aliases serialises the owner's local
  chat behind network jobs (and vice versa); a long local chat can push a
  queued network job toward the lease.
- The grant lane (web app) keeps legacy terms in this slice.
- The kai web app sends whole chat histories on the grant lane; histories
  above the legacy 4096-token estimate now get an immediate actionable 400
  instead of a slow failure or silent worker-side truncation. History
  trimming in the web app is a follow-up.
- No desktop UI for the opt-in; Core API only.
- No worker failure-report route; a refused job ages out via the lease.
- `/worker/register` has the same base64-whitespace replay gap as consume
  had; noted, not changed in this slice.
