# Content policy for the network: moderation hook + acceptable use (task #63)

Raised by an A40 operator (field report 2026-08-20), and they are right about
the shape of the problem: **the requester picks the model, but the operator's
hardware renders the output.** Today the only content filter anywhere in the
pipeline is whatever safety training the requested model happens to carry, so
per-operator filtering is uneven *by design*, and providers serve content they
never see (the serving path persists nothing — which is the privacy promise,
and also why an operator cannot audit after the fact).

Three pieces, in increasing order of policy weight. Building any of them is
days, not weeks; **what they say is the owner's call**, which is why nothing
here ships until that call is made.

## 1. Acceptable-use policy (documents first)

A short AUP published at koinosai.com: what the network refuses (illegal
content, CSAM, targeted harassment, malware authoring …), that operators
donate compute under this policy, and that violation forfeits access. Linked
from the app's Network privacy note and the docs. No code — but it is the
prerequisite for every enforcement step below, because you cannot enforce a
policy that does not exist.

- Needs from the owner: approve (or edit) a drafted AUP text.

## 2. Scheduler-side screening hook (code, env-gated, default off)

The scheduler already relays prompts in plaintext (white paper §13 is honest
about this), so it CAN screen without any new data exposure — screening is
reading, which the relay already does; it is not storing.

    KAI_MODERATION=off        today's behavior (default)
    KAI_MODERATION=log        counts per category, no content retained
    KAI_MODERATION=block      refuse the request with the AUP link

Phase 1 check: a small deny-list of unambiguous patterns (the categories the
AUP names), deliberately dumb — regexes catch the blatant and nothing else,
and false positives on a paid request are worse than misses. Phase 2 (later,
optional): route a sample of requests through a designated moderation-class
model on the network itself and feed the verdicts into the same counters.

- Tension to state honestly: any screening widens what the scheduler *does*
  with plaintext. `log` mode retains no content (counters only), and the AUP
  should say screening exists. Consumers who want zero screening always have
  Local-Only — that is the product's whole shape.
- Needs from the owner: whether to build it, and the starting mode.

## 3. Operator opt-out (per job class)

Partly exists: an operator only serves models they chose to download, and the
Earn tab's per-model gate verdicts (v0.28.7) show exactly what is offered.
What's missing is opting out of a JOB TYPE on a model you do serve — e.g.
"evals only, no consumer chat relay". Worker-side setting, advertised at
registration, honored by `_canServe`. Small, uncontroversial, and gives
operators like the reporter a real lever today.

- Needs from the owner: nothing beyond a go — this one has no policy content.

## Recommendation

Do 1 and 3 now (draft AUP for approval; ship the job-type opt-out), build 2
behind `off` so flipping it is an env change on the box, not a deploy. Screen
at the scheduler, never on operators' machines — operators must never be
handed content to judge, that is the scheduler's job.
