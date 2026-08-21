import json, sys, urllib.request, datetime

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
# The marker is the newest paragraph on the developer-tools page — bump it
# whenever a docs change matters enough to prove it landed.
DOCS_MARKER = ("/docs/content/koinos-code.md", "Clone a repo")
try:
    _, _, d = get(DOCS_MARKER[0], raw=True)
    check(DOCS_MARKER[1] in d, "docs deploy is current",
          f"{DOCS_MARKER[0]} carries {DOCS_MARKER[1]}" if DOCS_MARKER[1] in d
          else f"{DOCS_MARKER[0]} served WITHOUT {DOCS_MARKER[1]} — stale checkout on the box")
except Exception as e:
    check(False, "docs deploy is current", f"{DOCS_MARKER[0]} unreachable: {e}")

print(f"\nDIGEST {'FAIL' if fails else ('WARN' if warns else 'HEALTHY')} fails={len(fails)} warns={len(warns)}")
if fails: print("FAILING: " + "; ".join(fails))
if warns: print("WARNING: " + "; ".join(warns))
