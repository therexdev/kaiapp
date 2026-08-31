import json, sys, urllib.request, urllib.error, datetime

B = "https://koinosai.com"
def get(p, raw=False):
    with urllib.request.urlopen(B + p, timeout=20) as r:
        body = r.read().decode()
        return (r.status, dict(r.headers), body if raw else json.loads(body))

fails, warns = [], []
def check(cond, label, detail=""):
    (print if cond else print)(f"{'PASS' if cond else 'FAIL'}  {label}{' — ' + detail if detail else ''}")
    if not cond: fails.append(label)
def warn(cond, label, detail=""):
    if not cond:
        print(f"WARN  {label}{' — ' + detail if detail else ''}"); warns.append(label)
    else: print(f"PASS  {label}{' — ' + detail if detail else ''}")

now = datetime.datetime.now(datetime.timezone.utc)
def age_min(iso):
    t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return (now - t).total_seconds() / 60

st, hdr, _ = get("/", raw=True)
check(st == 200, "site answers 200", f"HTTP {st}")
check("caddy" in str(hdr.get("Via", "")).lower() or "caddy" in str(hdr.get("Server", "")).lower(),
      "served by Caddy (Vultr origin)", str(hdr.get("Via") or hdr.get("Server")))

_, _, h = get("/api/health")
rt = h.get("runtime", {}); store = h.get("store", {}); lx = rt.get("lastExit") or {}
check(h.get("ok") is True, "health ok")
check(store.get("mode") == "sqlite", "store.mode", store.get("mode"))
check("degraded" not in store, "store NOT degraded", str(store.get("degraded", "")))
check(isinstance(rt.get("bootCount"), int) and 0 < rt["bootCount"] < 10000, "bootCount sane", str(rt.get("bootCount")))
check("uncaughtException" not in str(lx.get("reason", "")), "clean last exit", str(lx.get("reason")))
print(f"STATE bootAt={rt.get('bootAt')} bootCount={rt.get('bootCount')} lastExit={lx.get('reason')}@{lx.get('at')}")
# Device relay (remote access, task #94): present since kai PR #47. Its
# absence means production is running pre-relay code — the app's Remote
# access switch would connect to nothing.
relay = h.get("relay")
check(isinstance(relay, dict), "device relay mounted", str(relay))
if isinstance(relay, dict):
    print(f"STATE relay tunnels={relay.get('tunnels')} pollers={relay.get('pollers')} jobs={relay.get('jobs')}")

"""
Privileged scheduler routes must refuse an unauthenticated caller.

FIND-CFG-001: these used to read `if (secret && header !== secret) refuse`,
which refuses nobody when KAI_OPERATOR_SECRET is unset — so a deploy that
forgot the variable published epoch closing, package revocation and job
injection to the internet while looking completely healthy from out here.
The code now fails closed, but "is the secret actually set on the box" is a
question about the DEPLOY, not the code, and the only honest way to answer it
is to knock without one and see what happens.

401 = the secret is set and this call did not have it. 503 = fixed code with
no secret configured, so the routes are disabled: safe, but the operator's own
tooling will not work either. 200 = the pre-fix fail-open is live, which is an
open door and the reason this check exists.
"""
try:
    req = urllib.request.Request(B + "/scheduler/operator/epochs")
    with urllib.request.urlopen(req, timeout=20) as r:
        op_status = r.status
except urllib.error.HTTPError as e:
    op_status = e.code
except Exception as e:  # network trouble is not evidence either way
    op_status = None
if op_status is None:
    warn(False, "operator routes: could not be reached to check")
else:
    check(op_status != 200, "privileged routes refuse an unauthenticated caller", f"HTTP {op_status}")
    warn(op_status != 503, "an operator secret is configured on the box",
         "HTTP 503 — routes are closed but KAI_OPERATOR_SECRET is unset")
    print(f"STATE operator_routes_unauthed=HTTP {op_status}")

_, _, s = get("/scheduler/network/status")
ws = s.get("workers", [])
check(s.get("workersOnline", 0) > 0, "workers online", str(s.get("workersOnline")))
# perf=null is a SCHEDULER fault only when a worker that ADVERTISES models
# never receives work. Two innocent cases are excused (both field events):
# a worker that joined minutes ago (2026-08-18: crashed this script), and a
# worker advertising ZERO models (2026-08-19: a tester machine whose models
# don't fit its RAM idled 20h online — the scheduler correctly gives it
# nothing, and the app tells that user to download a smaller model).
def excused(w):
    age = (w.get("reputation") or {}).get("ageDays")
    return (age is not None and age < 0.1) or not w.get("models")
serving = [w for w in ws if not excused(w)]
idle = [w for w in ws if excused(w)]
check(all(w.get("perf") for w in serving), "perf populated on every model-advertising worker",
      f"{len(idle)} excused (new or no servable models)" if idle else "")
ages = [(w["address"], w.get("reputation", {}).get("ageDays")) for w in ws]
check(all(a is not None and a > 0 for _, a in ages), "ageDays accumulating on ALL workers",
      " ".join(f"{a}:{d}" for a, d in ages))
check(s.get("queueDepth", 0) < 50, "queue not backed up", f"queue={s.get('queueDepth')} pending={s.get('pendingJobs')}")
# Which classes a paying caller can actually BUY right now. A network that
# drifts down to one servable class still passes every other line here —
# workers online, perf populated, queue empty — because those count machines,
# not menu. Print the menu, and fail if it empties out.
mods = s.get("models", [])
check(len(mods) > 0, "network advertises a servable class", f"{len(mods)} classes")
print("STATE models=%s" % " ".join(f"{m.get('model')}x{m.get('providers')}" for m in mods))
print("STATE instance=%s epoch_jobs=%s" % (s.get("instance"), [w.get("jobsThisEpoch") for w in ws]))
print("STATE perf_jobs=%s" % [(w.get("perf") or {}).get("jobs") for w in ws])
print("STATE ageDays=%s" % [d for _, d in ages])

rst, rhdr, r = get("/scheduler/network/roster")
r = json.loads(r) if isinstance(r, str) else r
check(r.get("count") == s.get("workersOnline"), "roster count tracks workersOnline",
      f"{r.get('count')} vs {s.get('workersOnline')}")
check(not any("…" in a for a in r.get("workers", [])), "no truncated address on the payout roster")
check(rhdr.get("Cache-Control") == "no-store", "roster is no-store", rhdr.get("Cache-Control"))

_, _, p = get("/scheduler/pricing")
o = p.get("oracle", {}); sm = o.get("smoothing", {})
warn(o.get("status") == "live", "oracle status", o.get("status"))
check(sm.get("floorUsd", 0) <= o.get("usd", 0) <= sm.get("ceilUsd", 0), "price inside floor/ceil", str(o.get("usd")))
warn(age_min(o["updatedAt"]) < 20, "oracle fresh", f"{age_min(o['updatedAt']):.1f} min old")
check(o.get("sources", 0) >= 2, "two price sources configured", str(o.get("sources")))
print(f"STATE oracle={o.get('status')} usd={o.get('usd')} median={o.get('lastMedian')} updatedAt={o.get('updatedAt')}")

# Docs freshness is a CONTENT check, not a status code: a stale checkout
# serves every page with a cheerful 200 and is invisible to HTTP probes.
# The marker is a phrase from the NEWEST docs paragraph — bump it whenever a
# docs change matters enough to prove it landed, and only AFTER that change
# has actually deployed. Moving it onto a page that has not landed turns the
# monitor red for a reason that has nothing to do with the site.
DOCS_MARKER = ("/docs/content/web-app.md", "recalled by relevance, not sent wholesale")
try:
    _, _, d = get(DOCS_MARKER[0], raw=True)
    check(DOCS_MARKER[1] in d, "docs deploy is current",
          f"{DOCS_MARKER[0]} carries {DOCS_MARKER[1]}" if DOCS_MARKER[1] in d
          else f"{DOCS_MARKER[0]} served WITHOUT {DOCS_MARKER[1]} — stale checkout on the box")
except Exception as e:
    check(False, "docs deploy is current", f"{DOCS_MARKER[0]} unreachable: {e}")

# The release notes page, and whether it has heard of the version people are
# actually being offered. The app's update popup deep-links to
# /updates#v<version>; a release that ships without its entry sends a tester
# to an anchor that does not exist. The page degrades gracefully, but the
# right time to find out is here, not from a confused tester.
try:
    ust, uhdr, u = get("/updates.json")
    rels = u.get("releases") or []
    check(ust == 200 and len(rels) > 0, "updates page has releases", f"{len(rels)} listed")
    check(uhdr.get("Cache-Control") == "no-store", "updates.json is no-store", uhdr.get("Cache-Control"))
    # `latest` is what the page badges; it must be the newest entry, or the
    # badge points at one release while the list leads with another.
    check(rels and u.get("latest") == rels[0].get("version"),
          "updates latest matches the newest entry",
          f"latest={u.get('latest')} first={rels[0].get('version') if rels else None}")
    # Read from the checkout the digest is running against, so this can never
    # drift from what is actually being released.
    import os
    _root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    APP_VERSION = json.load(open(os.path.join(_root, "package.json")))["version"]
    have = {r.get("version") for r in rels}
    check(APP_VERSION in have, "the shipping version has release notes",
          f"v{APP_VERSION} listed" if APP_VERSION in have
          else f"v{APP_VERSION} shipped with NO entry in updates.json — the What's new link lands on nothing")
    ps, _, page = get("/updates", raw=True)
    check(ps == 200 and "updates.js" in page, "/updates serves the page", f"HTTP {ps}")
except Exception as e:
    check(False, "updates page reachable", str(e))

# Which sign-in doors are actually open in production. Reported as STATE, not
# as an assertion: "Google is off" is a configuration CHOICE, not a fault, and
# a digest that cried FAIL over it would be noise. But it must be VISIBLE —
# the owner had to ask what was needed, which means the system was not saying.
try:
    _, _, m = get("/auth/methods")
    si, su = m.get("signin", {}), m.get("signup", {})
    on = lambda d: ",".join(k for k, v in d.items() if v) or "none"
    print(f"STATE signin={on(si)} signup={on(su)} missing={','.join(m.get('missing') or []) or 'nothing'}")
    warn(m.get("canCreateAccount") is True, "account creation possible",
         "email or Google is configured" if m.get("canCreateAccount")
         else "NOBODY can sign up — a passkey cannot create an account; set " + " or ".join(m.get("missing") or ["SMTP_HOST"]))
except Exception as e:
    warn(False, "account creation possible", f"/auth/methods unreachable: {e}")

print(f"\nDIGEST {'FAIL' if fails else ('WARN' if warns else 'HEALTHY')} fails={len(fails)} warns={len(warns)}")
if fails: print("FAILING: " + "; ".join(fails))
if warns: print("WARNING: " + "; ".join(warns))

# Exit non-zero on a FAIL, so the workflow badge says what the digest says.
#
# This script used to always exit 0, and the operating rule was "read the
# DIGEST line, the tick only means the script ran". That rule was followed and
# it still failed: a run went green with `DIGEST FAIL fails=1` inside it, and
# nothing surfaced. A verdict nobody can see from the outside is not a verdict.
#
# WARNs stay silent on purpose. The oracle sits in stale-hold for up to ~45
# minutes after every restart, which is expected, and a check that cries wolf
# after each deploy is one people learn to ignore — which is the same failure
# in the opposite direction.
import sys
sys.exit(1 if fails else 0)
