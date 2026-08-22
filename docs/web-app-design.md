# Koinos AI Web — architecture

**Status: v1 SHIPPED 2026-08-22 — koinosai.com/app (kai PRs #21-#25, kaiapp
v0.42.0).** Chat, Docs, Tasks, Memory and Wallet are live; §4 was built as
written. What is below stays as the record of WHY, because every constraint in
it turned out to be load-bearing — especially §3, which is the reason spending
is a grant rather than a key in a browser.

Two things the build changed from this document:

- **§4 said "no Compare, no Tools".** Still true, and the reason is now written
  where users see it (docs.koinosai.com → Koinos AI on the web): those need the
  caller's own hardware or the desktop tool layer. Web tasks get the model and
  nothing else — no tools, no search.
- **A grant is PERMISSION, not FUNDS.** This document assumed a linked wallet
  with a balance. In practice the two failures are indistinguishable from
  outside ("I authorised it and it still refuses"), so the wallet-capacity
  requirement is now stated in the gate copy, the desktop Settings hint and the
  docs. That was the one real gap between the design and what a person meets.

**STILL UNVERIFIED, and only a human can close it**: nobody has driven the loop
end to end with a real wallet and a real provider. Every path is probe-covered
against a fake provider; none has met a real one with a person at the keyboard.

---

*Original status when this was written:*
**RESEARCHED 2026-08-22, four forks await the owner. Nothing built.**
Owner asked for a web app with Chat / Docs / Compare / Tasks / Tools, the same
login as koinosai.com/account, gated on a connected wallet, spending KAI from
linked wallets — with a stated future of account-generated wallets and buying
and converting KAI in-app.

Every claim below was read out of the code. File:line references are in the
research transcript; the load-bearing ones are inline.

---

## 0. Read this first — the framing has a hole in it

**"Connect a wallet to use it" has no browser implementation in this
codebase.** There is no Koinos browser signer here, and the only key that can
produce a link proof today lives in the desktop keystore (`core/lib/wallet.js`).
So taken literally, v1's gate means **you must already have the desktop app in
order to use the web app** — which inverts the acquisition funnel the web app
presumably exists to create.

That is not a reason to abandon the gate. It is a reason to decide Fork 1
before scoping v1, because the answer changes who the product is for.

---

## 1. The central reframe

A browser has no local Core — and Core is not just a model runtime. It is
simultaneously the **GPU**, the **disk**, the **process host**, and the
**private key**. Strip it and all four go.

So this is **a hosted, metered, network-served inference client that shares an
identity system with koinosai.com**. It is not a port of the desktop app, and
it cannot carry the desktop app's promise: *"Runs on your hardware. Nothing
leaves this machine."* — which is rendered in the sidebar of all five requested
views. Every token a web user consumes runs on someone else's machine and costs
money. That sentence is the whole design.

---

## 2. Per-feature verdict

| Feature | Verdict | Why |
|---|---|---|
| **Chat** | Ships, partially | Plain chat + Research port cleanly (pure egress). **Agent and Team do not** — `run_code` spawns a Node child, file tools write a real workspace. **Voice does not** — `/core/transcribe` spawns `whisper-cli`, and it is exempt from the privacy gate *precisely because* audio never leaves the machine. Hosting it inverts its own justification. |
| **Docs** | Ships cleanly | Four CRUD routes over one JSON file each, plus one streaming completion. Caveat: `docs-view.js` also carries a custom-model import with a native file dialog — split it, or you drag a "type an absolute path" box into a browser pointing at *your server's* disk. |
| **Tasks** | Ships, and gets BETTER | Pure CRUD; the runner loops back through the same chat front door. The code currently apologises for itself — *"tasks run while Koinos AI is running — this is a desktop app, not a cloud"* — and hosting fixes exactly that. **But** it is the only feature that spends money with nobody watching, so it must not ship before the spend cap. |
| **Compare** | Cut from v1 | Its sequential UX is an artifact of the single local runtime slot; three user-facing strings ("they share the machine") become false on a server. Worse, the picker exposes one network entry while the run handler refuses two identical picks — **with no local models it is dead on arrival with an unhelpful error**. Needs `/core/network/models` split into pickable entries first. Least valuable of the five to a paying user. |
| **Tools** | **Does not translate. Not in v1.** | Three unrelated things in one pane. The MCP half is 100% local child processes *by construction* — every catalog entry is `stdio` + `npx`, connect spawns, the runtime button downloads and chmods a Node binary. There is no server-servable subset. The consent dialog's premise — *"a PROGRAM that runs on this computer with your user account"* — is the trust model, not copy. **Memory**, by contrast, is the most portable thing in the app (TF-IDF over JSON) and should be lifted out of Tools and folded into Chat. **Email/Calendar** are servable but make you the holder of your users' IMAP passwords — a liability decision, not a port. |

Also: **delete, do not port, the hardware card.** On a server it truthfully
describes the wrong computer, which is worse than showing nothing.

---

## 3. Payment — more exists than expected

**Already built, end to end:** on-chain KAI deposits sync into a per-address
prepaid µ$ balance under an idempotent high-water mark, and `_chargeUsage`
debits per token in a fixed order — free allowance → deposited KAI → epoch
earnings. The deposit lane is mana-sponsored and explicitly non-custodial (the
operator co-signs a *validated* transaction and refuses to blind co-sign).
Account↔wallet linking already carries an account-bound signed proof.

**So "convert KAI to tokens", which the owner described as a future update, is
already built.** What is missing from that future is a fiat on-ramp and
browser-side deposit signing — not the conversion.

**New work, in dependency order:**

1. **A second consumer credential.** The consume handler hard-requires a
   per-request secp256k1 signature and 401s without it. There is no auth hook
   to parameterize. Cheap part: accounts and scheduler are **one process**, so
   this is an in-process lookup, not an RPC.
2. **A delegation record.** The `wallets` table stores address, account, label,
   linked_at — **no scope, no cap, no expiry, no revocation**, and unlink needs
   no proof. "Linked" means *proved ownership once*, not *authorized this site
   to spend*. The right shape already exists in `core/lib/keys.js`
   (`budgetUsdMonthly`, `budgetRemainingMicro`) — but the enforcement point
   must move: on the desktop it is a self-imposed cap on your own machine; on
   the web it is a real authorization boundary and must run server-side.
3. **A pre-authorization hold.** Today's gate is a bare `> 0`, with cost known
   only *after* execution. One µ$ authorizes an arbitrarily expensive request.
   For a worker the overdraft lands on epoch earnings; for a web user it lands
   in `debts`, which `closeEpoch` records, reports, **and then wipes with no
   carry-forward**. A web user can spend money that does not exist and nobody
   collects it. Require `max_tokens`, reserve against it, settle on result.
4. **Account-keyed free tier.** Free tokens are keyed on address + client IP
   taken from the last XFF entry. **Behind a CDN every web user collides into
   one 75,000-token/day bucket** and races the 1M/day global ceiling. And
   `_freeTokensLeft` performs no eligibility check at all.
5. **Multi-wallet billing** (two linked wallets are two unrelated balances),
   **idempotency** (a retried fetch double-bills), and **per-account rate
   limiting** (every limiter today is per-IP and in-memory).

### The parts that are not engineering questions

- **"Creating an account will generate a wallet" is custody.** The moment the
  server can produce a user's signature, you hold customer funds. That
  contradicts the posture the code states out loud (*"the user's key never
  leaves their machine"*). Key management, insider risk, recovery, and in most
  jurisdictions a regulatory classification arrive with it. **Decide before
  building, not after.**
- **Never accept a pasted private key or an uploaded keystore on the website.**
  It is the path of least resistance to "connect a wallet in a browser" and it
  is catastrophic.
- **The instant a session can spend, session hygiene becomes a financial
  control.** Today: `kai_session` is a 30-day *sliding* token with no absolute
  lifetime; it is **also returned in the login response body where page JS can
  read it**; a bearer token bypasses the Origin/Referer CSRF check entirely;
  **there is no CSP anywhere on the origin**; there is no revoke-all and no
  session list; and passkey `userVerified` is computed then thrown away, so
  step-up auth is impossible. Right now one XSS costs an email address. After
  spend authority it is a permanent, unrevocable drain. **Prerequisite, not
  follow-up.**
- **`POST /auth/device/start` is unauthenticated and unthrottled**, and the
  approval UI shows the user nothing about what they are approving. Today a
  social-engineered code leaks chat history; after spend it leaks money.
- **Wallet-connect is not a paywall and not an abuse control.** Linking is free
  and unlimited. Decide what a connected wallet with a zero balance may do.
- **Vocabulary collision.** "Tokens" here means *LLM tokens*. Three balances
  exist and are not interchangeable: on-chain KAI, the prepaid µ$ deposit
  balance, and unsettled epoch earnings — and `/balance`'s `pendingKai` is
  explicitly a shrinkable estimate that must never be shown as spendable. A web
  user maps onto the prepaid balance **only**: show `balanceUsd`, never
  `pendingKai`. Fix this in copy before it ships.

---

## 4. The smallest honest v1

**Chat (plain + web search + Research), Docs, Tasks, and Memory folded into
Chat.** Not Compare. Not Tools. Not voice, Agent, or Team.

- **Surface:** same-origin SPA at `/app`. Shell in `views/`, **never
  `public/`** — `express.static(PUBLIC_DIR)` serves that whole tree ungated, so
  a gated shell there is not merely inadvisable, it is impossible. Copy the
  admin pattern: `sendFile` on session, sign-in view otherwise. Hash-routed
  (there is no SPA catch-all, and adding a global one would swallow the
  marketing site's honest 404s). No build step. `no-store`,
  `X-Frame-Options: DENY`, `X-Robots-Tag: noindex`, robots.txt Disallow.
- **Auth:** export and reuse `requireAccount` rather than re-deriving it — a
  lookalike gate is one forgotten `crossSite` check from being a CSRF hole.
  **(Done: exported 2026-08-22.)** Land a CSP scoped to `/app` only; every
  existing page uses inline script and would break under a global one. Stop
  returning the session token in the login response body.
- **Data:** a new sqlite DB beside `accounts.sqlite` — never joined to the
  scheduler's store, which participates in epoch-close transactions. Four
  tables replacing four JSON-file stores. This is the boring half and it is
  most of the work.
- **Money — server-side delegation, non-custodial.** Link the wallet as today,
  then sign a *second* message — `spend|address|accountId|maxMicro|expiresAt|ts`
  — stored in a `spend_grants` table with cap, expiry and revocation surfaced
  on /account. Same primitive as `linkWallet`, different meaning. **The web
  tier never forges a consume signature**: the scheduler grows one alternate
  authorization branch resolved in-process, and the ledger stays address-keyed.
  Only *who may draw on it* is new.
- **Free tier:** keyed on account id, or **none at all** in v1 — which is the
  honest reading of "connect a wallet to use it".

**Why this does not corner you.** The delegation record is the seam, and it is
indifferent to where the key lives. When accounts later generate wallets, a
generated wallet is just another linked address whose grant is created at
signup. When fiat purchase arrives, you are adding a *funding* path into a
deposit lane that already exists and is idempotent. You never re-plumb
spending. Every alternative — browser-held keys, a parallel web-only billing
system, custodial signing bolted on later — forces a rewrite of the spend path
at exactly the moment paying users are on it.

---

## 5. Forks the owner must decide

1. **Does the server ever hold or generate a user's key?** Non-custodial keeps
   one XSS to an inconvenience and preserves the stated posture. Custodial —
   the stated future — makes session compromise a drain and brings key
   management, recovery and regulatory classification. The delegation seam
   works under both, but the security work differs by an order of magnitude.
   **This also decides whether v1 is usable by someone who has never installed
   the desktop app** (see §0).
2. **Is the hosted app the same product, or a second product?** *"Nothing
   leaves this machine"* is the desktop product's entire claim, and the hosted
   app inverts it. Coherent: a distinct, honestly-labelled network product.
   Also coherent: one brand with a promise it cannot keep. This decides copy,
   feature legitimacy, and whether voice or Tools could ever ship on the web
   without lying.
3. **What is an unfunded web user entitled to?** No free tier (simplest, and
   what "connect a wallet to use" literally implies); account-keyed free tier
   (needs a Sybil answer — email verification is all there is); or leave it and
   watch web users race each other for one shared bucket. This decides whether
   the product can be tried before it is funded, which decides the funnel.
4. **Will the web app ever execute code or hold files for users?** Yes ⇒ you
   are buying per-tenant sandbox infrastructure as a permanent ops discipline,
   and it unlocks Agent, Team, and a plausible HTTP-only MCP story. No ⇒ the
   web app is inference + CRUD forever, three of the five requested views are
   the ceiling, and Tools as designed is permanently out. The current sandbox
   was written to protect one user's disk from one user's model; it does not
   survive multi-tenancy unchanged.
