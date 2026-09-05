import json, os, sys, urllib.request, urllib.error, datetime

B = "https://koinosai.com"
def get(p, raw=False):
    with urllib.request.urlopen(B + p, timeout=20) as r:
        body = r.read().decode()
        return (r.status, dict(r.headers), body if raw else json.loads(body))

fails, warns = [], []
# Everything the scheduled stability check reads, gathered as it is computed
# and printed as a single LAST line. The body of this digest grows and shrinks
# as checks are added, so reading it from outside means guessing a log tail
# length and fetching again when the guess is short — which it repeatedly was.
# The runner's trailing noise IS fixed-length, so one line at the very end is
# reachable with a small, stable tail forever.
SUM = {}
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
         f"HTTP {op_status} — the secret is set and this call did not have it"
         if op_status != 503 else
         "HTTP 503 — the routes fail closed, but KAI_OPERATOR_SECRET is unset "
         "so the operator's own tooling cannot reach them either")
    print(f"STATE operator_routes_unauthed=HTTP {op_status}")

_, _, s = get("/scheduler/network/status")
ws = s.get("workers", [])
check(s.get("workersOnline", 0) > 0, "workers online", str(s.get("workersOnline")))
SUM["workers"] = s.get("workersOnline")
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
SUM["queue"] = s.get("queueDepth")
# Which classes a paying caller can actually BUY right now. A network that
# drifts down to one servable class still passes every other line here —
# workers online, perf populated, queue empty — because those count machines,
# not menu. Print the menu, and fail if it empties out.
mods = s.get("models", [])
check(len(mods) > 0, "network advertises a servable class", f"{len(mods)} classes")
print("STATE models=%s" % " ".join(f"{m.get('model')}x{m.get('providers')}" for m in mods))
SUM["classes"] = len(mods)
SUM["models"] = ",".join(sorted(str(m.get("model")) for m in mods))
# FIND-NET-001 rollout. Registration proofs deploy in SHADOW: a node running a
# client too old to sign still registers, and is marked. That is a schedule,
# not a resting state — until this reaches 0 the scheduler is still taking
# some payee addresses on trust, which is the finding. Warn (not fail) while
# it is non-zero and enforcement is off, because that is the expected shape
# during rollout; FAIL if an unsigned worker is on the roster after
# enforcement was supposed to close the door.
unsigned = s.get("workersUnsigned")
enforced = bool(s.get("workerProofEnforced"))
if unsigned is None:
    warn(False, "scheduler reports registration-proof state", "deploy predates FIND-NET-001")
elif enforced:
    check(unsigned == 0, "no unsigned worker survives enforcement", f"{unsigned} unsigned")
else:
    warn(unsigned == 0, "every worker proves the address it is paid as",
         f"{unsigned} of {s.get('workersOnline')} still unsigned — shadow mode, arm KAI_WORKER_PROOF_ENFORCE once this is 0")
# WHICH nodes, not just how many. The count decides when to arm enforcement;
# the addresses decide who to go and ask to update, and that is the action the
# warn exists to prompt. Derived from the same rule the counter uses, and if
# the two disagree that is itself worth seeing rather than papering over.
named = [w["address"] for w in ws if (w.get("proof") or "unsigned") != "signed"]
if unsigned:
    print("STATE worker_proof_unsigned=%s%s" % (
        " ".join(named) or "NAMES UNAVAILABLE (no per-worker proof field)",
        "" if len(named) == unsigned else f"  [!] roster names {len(named)}, counter says {unsigned}"))
print(f"STATE worker_proof enforced={enforced} unsigned={unsigned}")
print("STATE instance=%s epoch_jobs=%s" % (s.get("instance"), [w.get("jobsThisEpoch") for w in ws]))
print("STATE perf_jobs=%s" % [(w.get("perf") or {}).get("jobs") for w in ws])
print("STATE ageDays=%s" % [d for _, d in ages])
# SORTED, because the array order is not stable between runs and comparing by
# position invents departures that never happened.
SUM["ages"] = ",".join(str(d) for d in sorted(d for _, d in ages))

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
SUM["oracle"] = f"{o.get('status')}/{age_min(o['updatedAt']):.1f}m"
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
    SUM["updates"] = u.get("latest")
    ps, _, page = get("/updates", raw=True)
    check(ps == 200 and "updates.js" in page, "/updates serves the page", f"HTTP {ps}")
except Exception as e:
    check(False, "updates page reachable", str(e))

"""
The alpha page's download offer, checked against what the release actually
holds.

v0.54.0 is why this exists. The macOS job built the disk images, validated
both Mach-O architectures, and then skipped the upload step because its
condition was written for a tag-based release flow this repo does not use.
Every job went green. Windows and Linux landed on the release. Mac testers
had a page announcing macOS support and nothing to download, and the only
thing that would have caught it was somebody looking.

So the assertion is not "does the page say Mac" or "does the release have a
dmg" — it is BOTH, together. A page offering a download the release cannot
supply is the failure, and either half alone looks fine.
"""
try:
    ts, _, tp = get("/testers", raw=True)
    check(ts == 200, "/testers serves the page", f"HTTP {ts}")
    offers_mac = ".dmg" in tp
    check("releases/latest" in tp, "/testers points at the latest release")

    """
    Authenticated when a token is available.

    The first version of this call was anonymous, and anonymous GitHub API
    access is 60 requests/hour PER IP — shared across every Actions runner on
    that address. It duly returned "403 rate limit exceeded" and the digest
    reported a FAIL, which is the one thing this check must never do: it said
    the downloads were broken when it had simply been unable to look. A
    monitor that cries wolf gets ignored, and then it is worth nothing on the
    day it is right.
    """
    _hdrs = {"Accept": "application/vnd.github+json", "User-Agent": "koinos-netcheck"}
    _tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if _tok:
        _hdrs["Authorization"] = f"Bearer {_tok}"
    with urllib.request.urlopen(urllib.request.Request(
        "https://api.github.com/repos/therexdev/kaiapp/releases/latest",
        headers=_hdrs,
    ), timeout=20) as r:
        rel = json.loads(r.read().decode())
    names = [a.get("name", "") for a in rel.get("assets", [])]
    kinds = {ext: sorted(n for n in names if n.endswith(ext)) for ext in (".dmg", ".exe", ".AppImage")}
    print(f"STATE release={rel.get('tag_name')} assets={len(names)} "
          f"dmg={len(kinds['.dmg'])} exe={len(kinds['.exe'])} AppImage={len(kinds['.AppImage'])}")
    SUM["release"] = rel.get("tag_name")
    SUM["downloads"] = f"dmg{len(kinds['.dmg'])}/exe{len(kinds['.exe'])}/appimage{len(kinds['.AppImage'])}"

    # Every platform the page offers must be downloadable from that release.
    for ext, label in ((".exe", "Windows"), (".AppImage", "Linux"), (".dmg", "macOS")):
        if ext == ".dmg" and not offers_mac:
            continue
        check(len(kinds[ext]) > 0, f"{label} download exists on {rel.get('tag_name')}",
              ", ".join(kinds[ext]) if kinds[ext]
              else f"/testers offers {ext} and the release has none — the build skipped its upload")
    check(offers_mac, "/testers offers the macOS build",
          "shipped since v0.54.1" if offers_mac
          else "the Mac download vanished from the alpha page")
    # Both architectures, or half the Mac testers are stuck.
    if offers_mac:
        check(any("arm64" in n for n in kinds[".dmg"]) and any("x64" in n for n in kinds[".dmg"]),
              "both Mac architectures published", ", ".join(kinds[".dmg"]))
except urllib.error.HTTPError as e:
    """
    Could not ASK is not the same as the answer being bad.

    A 403 (rate limit) or a 5xx from GitHub says nothing whatsoever about
    whether the downloads exist. Reporting it as FAIL conflates "the release
    is missing its installer" — which needs someone out of bed — with "the
    API was busy", which needs nothing. WARN keeps it visible without the
    alarm.
    """
    warn(False, "testers page and its downloads — could not check", f"HTTP {e.code}: {e.reason}")
    SUM["release"] = f"unchecked({e.code})"
except Exception as e:
    check(False, "testers page and its downloads", str(e))

"""
The web app is installable — checked in production, not just merged.

Same lesson as the /testers download check: "the change is on the branch" and
"the thing works for a user" are different claims, and only the second one
matters. A PWA fails in exactly the silent way that deserves a monitor — if
the manifest 404s, comes back as the sign-in page, or loses a required icon
size, browsers report NOTHING. The install option simply stops appearing and
the page looks perfect.

The manifest must answer ANONYMOUSLY, because browsers fetch it without
credentials. The day someone moves it behind the /app session gate it starts
returning a redirect to sign-in and the app quietly stops being installable.
"""
try:
    mst, mhdr, mtext = get("/app/manifest.webmanifest", raw=True)
    check(mst == 200, "app manifest answers anonymously", f"HTTP {mst}")
    mf = json.loads(mtext)
    check(mf.get("display") == "standalone",
          "app manifest says standalone (the 'without the browser' bit)", mf.get("display"))
    # scope must cover /account, or an expired session is ejected into a
    # browser tab — which to the person holding the phone looks like a crash.
    check(mf.get("scope") == "/", "app manifest scope covers sign-in", mf.get("scope"))
    isizes = {i.get("sizes") for i in mf.get("icons") or []}
    check({"192x192", "512x512"} <= isizes, "app manifest has both required icon sizes", " ".join(sorted(isizes)))
    # Every icon it promises must actually be there. A manifest referencing a
    # missing icon is not installable, and nothing says so out loud.
    missing = []
    for ic in mf.get("icons") or []:
        try:
            ist, _, _ = get(ic["src"], raw=True)
            if ist != 200:
                missing.append(f"{ic['src']}={ist}")
        except Exception as e:
            missing.append(f"{ic['src']}={e}")
    check(not missing, "every app icon the manifest promises is served", ", ".join(missing) or "all present")
    sst, shdr, _ = get("/app/sw.js", raw=True)
    check(sst == 200, "app service worker serves", f"HTTP {sst}")
    # Without this header the worker cannot claim "/app" — the start_url, and
    # therefore the one page the homescreen icon opens.
    check(shdr.get("Service-Worker-Allowed") == "/app",
          "service worker may claim the start_url", shdr.get("Service-Worker-Allowed"))
    SUM["pwa"] = f"ok/{len(mf.get('icons') or [])}icons"
except Exception as e:
    check(False, "app is installable (PWA)", str(e))
    SUM["pwa"] = "FAIL"

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

# The last line, and the only one a healthy run needs read.
print(
    "DIGEST SUMMARY"
    f" fails={len(fails)} warns={len(warns)}"
    f" workers={SUM.get('workers')}"
    f" ages={SUM.get('ages', '?')}"
    f" classes={SUM.get('classes')}"
    f" queue={SUM.get('queue')}"
    f" oracle={SUM.get('oracle', '?')}"
    f" updates={SUM.get('updates', '?')}"
    f" release={SUM.get('release', '?')}"
    f" downloads={SUM.get('downloads', '?')}"
    f" pwa={SUM.get('pwa', '?')}"
    f" models={SUM.get('models', '?')}"
)

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
