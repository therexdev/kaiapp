#!/usr/bin/env python3
"""Read-only, sanitized inventory for the KAI credit-service operator.

Uses Python's standard library. Never imports service code, opens wallet/key
files, sends credentials, signs, deploys, restarts, or changes live SQLite files.
Bounded SQLite snapshots are queried in a private temporary directory because
opening a WAL database directly can create/update its shared-memory sidecar.
"""
import argparse
import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

EXPECTED_MASTER = "15CM9Qr4GKREDgqnyXJ8tckPj2biERTM1T"
PRODUCTS = {"legacy-reservations", "prepaid-v1", "prepaid-usd-v1"}
MODES = {"mainnet-pilot", "test-deployment"}
STATES = {"queued", "running", "ready", "charged", "cancelled", "failed",
          "pending", "confirmed", "rejected", "signing", "signed", "submitted",
          "reversible", "finalized", "complete", "needs_review", "prepared",
          "verified", "settled", "expired", "released", "claimed"}
SERVICES = {
    "legacy": ("kai-koin-mainnet-pilot.service", "/etc/kai-koin-mainnet-pilot", "/var/lib/kai-koin-mainnet-pilot"),
    "usd": ("kai-koin-prepaid.service", "/etc/kai-koin-prepaid", "/var/lib/kai-koin-prepaid"),
}
DATABASES = {
    "signatures": ("signing/test-signing.sqlite", "signatures"),
    "rewardSteps": ("cycle/reward-cycle.sqlite", "steps"),
    "rewardClaims": ("claims/reward-claims.sqlite", "claims"),
    "creditPurchases": ("scheduler/prepaid/prepaid.sqlite", "purchases"),
    "creditRequests": ("scheduler/prepaid/prepaid.sqlite", "jobs"),
    "legacyRequests": ("scheduler/koin-funded-sessions/funded-reservations.sqlite", "holds"),
}
MAX_JSON = 512 * 1024
MAX_DB = 32 * 1024 * 1024


class InspectionError(Exception):
    pass


def rooted(root, absolute):
    return root / str(absolute).lstrip("/")


def regular(path, limit):
    # Refuse links in the selected path rather than following them to secrets.
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise InspectionError("symlink-refused")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise InspectionError("unsupported-file")
    return info


def read_json(path):
    try:
        regular(path, MAX_JSON)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as file:
            value = json.loads(file.read(MAX_JSON + 1))
        if not isinstance(value, dict):
            return None, "invalid-json"
        return value, "read"
    except FileNotFoundError:
        return None, "missing"
    except PermissionError:
        return None, "permission-denied"
    except InspectionError as error:
        return None, str(error)
    except (OSError, ValueError):
        return None, "unreadable-json"


def number(value, positive=False):
    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]{0,19}", value):
        return None
    if int(value) > 2**64 - 1 or (positive and int(value) == 0):
        return None
    return value


def field_object(value):
    return value if isinstance(value, dict) else {}


def inspect_configuration(path, root):
    value, state = read_json(path)
    if value is None:
        return {"state": state}
    # Accept runtime.json or the public fields in plan.json/settings JSON.
    c = field_object(value.get("runtime")) or field_object(value.get("settings")) or value
    d = field_object(c.get("deployment")) or field_object(value.get("deployment"))
    tariff = field_object(c.get("tariff"))
    free = field_object(c.get("freePolicy"))
    pricing = field_object(c.get("purchasePricing"))
    quality = field_object(c.get("qualificationPolicy"))
    product = d.get("product", "legacy-reservations")
    result = {
        "state": "read", "validation": "presence-only-not-activation",
        "product": product if isinstance(product, str) and product in PRODUCTS else "unrecognized",
        "publicAccounts": c.get("accountMode") == "public",
        "masterDestinationMatches": d.get("masterNode") == EXPECTED_MASTER,
        "contractPinsPresent": all(isinstance(d.get(k), str) and bool(d[k]) for k in
                                   ("credits", "rewards", "creditsHash", "rewardsHash", "chainId")),
        "tariffUsdAtomsPerMillion": {
            "input": number(tariff.get("inputAtomsPerMillion"), True),
            "output": number(tariff.get("outputAtomsPerMillion"), True),
        },
        "freePolicy": {
            "present": bool(free),
            "accountDailyUsdAtoms": number(free.get("accountDaily"), True),
            "networkDailyUsdAtoms": number(free.get("networkDaily"), True),
            "originDailyUsdAtoms": number(free.get("originDaily"), True),
            "eligibleModelsConfigured": isinstance(free.get("eligibleModels"), list) and bool(free["eligibleModels"]),
        },
        "purchasePricing": {
            "present": bool(pricing),
            "twoArchiveSourcesConfigured": isinstance(pricing.get("rpcUrls"), list) and len(pricing["rpcUrls"]) == 2,
            "usdtFeedConfigured": bool(re.fullmatch(r"0x[0-9a-f]{40}", str(pricing.get("usdtFeed", "")))),
            "paritySignerConfigured": isinstance(pricing.get("paritySigner"), str) and bool(pricing["paritySigner"]),
            "parityFileConfigured": isinstance(pricing.get("parityFile"), str) and os.path.isabs(pricing["parityFile"]),
            "policyConfigured": isinstance(pricing.get("policy"), dict) and bool(pricing["policy"]),
            "liveEvidenceVerified": False,
        },
        "automaticQualificationConfigured": bool(quality),
        "resourceBudgetConfigured": all(number(c.get(k), True) is not None for k in ("maxRcPerTransaction", "maxRcPerDay")),
    }
    # Check metadata only, never open a configuration-supplied evidence path.
    # This cannot accidentally read a key file mislabeled as an attestation.
    parity_path = pricing.get("parityFile")
    if isinstance(parity_path, str) and os.path.dirname(parity_path) == "/etc/kai-koin-prepaid":
        try:
            regular(rooted(root, parity_path), 8192)
            parity_state = "present-not-read"
        except FileNotFoundError:
            parity_state = "missing"
        except (OSError, InspectionError):
            parity_state = "unavailable"
        result["purchasePricing"]["localParityFile"] = parity_state
        result["purchasePricing"]["paritySignatureVerified"] = False
    return result


def inspect_service(unit, fixture=False):
    if fixture:
        return {"state": "not-queried-fixture"}
    try:
        process = subprocess.run(["systemctl", "show", unit, "--property=LoadState,ActiveState,SubState,WorkingDirectory"],
                                 check=False, capture_output=True, text=True, timeout=5)
        if process.returncode:
            return {"state": "unavailable"}
        values = dict(line.split("=", 1) for line in process.stdout.splitlines() if "=" in line)
        permitted = {"loaded", "not-found", "active", "inactive", "failed", "activating", "deactivating", "running", "dead", "exited", "auto-restart"}
        out = {k: values.get(k) if values.get(k) in permitted else "unknown" for k in ("LoadState", "ActiveState", "SubState")}
        commit = os.path.basename(values.get("WorkingDirectory", ""))
        out["sourceCommit"] = commit if re.fullmatch(r"[a-f0-9]{40}", commit) else None
        return out
    except (OSError, subprocess.TimeoutExpired):
        return {"state": "unavailable"}


def inspect_account_environment(path):
    # Credentials must remain unread: metadata is sufficient for this report.
    try:
        info = regular(path, 65536)
        return {"state": "present-not-read", "rootOwned": info.st_uid == 0,
                "ownerOnlyPermissions": info.st_mode & 0o077 == 0}
    except FileNotFoundError:
        return {"state": "missing"}
    except (OSError, InspectionError):
        return {"state": "unavailable"}


def fingerprint(path):
    info = regular(path, MAX_DB)
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def inspect_database(path, table):
    if not path.exists():
        return {"state": "missing"}
    try:
        sources = [path] + [Path(str(path) + suffix) for suffix in ("-wal",) if Path(str(path) + suffix).exists()]
        before = {source: fingerprint(source) for source in sources}
        with tempfile.TemporaryDirectory(prefix="kai-credit-preflight-") as folder:
            os.chmod(folder, 0o700)
            for source in sources:
                target = Path(folder) / source.name
                # No SQLite engine ever opens the live files. No runtime imports.
                with os.fdopen(os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as inp:
                    with os.fdopen(os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "wb") as out:
                        copied = 0
                        while True:
                            chunk = inp.read(65536)
                            if not chunk:
                                break
                            copied += len(chunk)
                            if copied > MAX_DB:
                                raise InspectionError("snapshot-too-large")
                            out.write(chunk)
            after = {source: fingerprint(source) for source in sources}
            if before != after or (Path(str(path) + "-wal").exists() != any(str(s).endswith("-wal") for s in sources)):
                return {"state": "busy-retry-later"}
            db = sqlite3.connect((Path(folder) / path.name).as_uri() + "?mode=ro", uri=True, timeout=1)
            try:
                db.execute("PRAGMA query_only=ON")
                db.execute("PRAGMA trusted_schema=OFF")
                deadline = time.monotonic() + 2
                db.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 10000)
                # Table identifiers come exclusively from DATABASES, never files.
                if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                    return {"state": "schema-unrecognized"}
                counts = {}
                for state, count in db.execute('SELECT state, COUNT(*) FROM "' + table + '" GROUP BY state LIMIT 128'):
                    label = state if state in STATES else "other"
                    counts[label] = counts.get(label, 0) + count
                return {"state": "read-snapshot", "counts": counts,
                        "note": "Local records only; not blockchain finality verification"}
            finally:
                db.close()
    except PermissionError:
        return {"state": "permission-denied"}
    except InspectionError as error:
        return {"state": str(error)}
    except (OSError, sqlite3.Error):
        return {"state": "unreadable-snapshot"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def inspect_endpoint(url, auth_methods=False):
    try:
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=4) as response:
            body = response.read(65537)
            if len(body) > 65536:
                return {"state": "response-too-large"}
            value = json.loads(body)
            if not isinstance(value, dict):
                return {"state": "invalid-response"}
            if auth_methods:
                return {"state": "responding", "canCreateAccount": value.get("canCreateAccount") is True,
                        "emailSignup": field_object(value.get("signup")).get("email") is True,
                        "googleSignup": field_object(value.get("signup")).get("google") is True}
            stamp = value.get("lastSuccess")
            fresh = isinstance(stamp, int) and not isinstance(stamp, bool) and 0 <= int(time.time()*1000) - stamp <= 60000
            product = value.get("product")
            mode = value.get("mode")
            return {"state": "responding", "product": product if isinstance(product, str) and product in PRODUCTS else "not-reported",
                    "mode": mode if isinstance(mode, str) and mode in MODES else "not-reported",
                    "servingHeartbeatFresh": fresh, "paymentsFlag": value.get("mainnetPaymentsEnabled") is True}
    except urllib.error.HTTPError as error:
        return {"state": "http-error", "httpStatus": error.code}
    except (OSError, ValueError):
        return {"state": "unreachable-or-invalid-response"}


def report(root=Path("/"), offline=False):
    fixture = root != Path("/")
    output = {"schema": 1, "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "readOnly": True, "productionAcceptance": False,
              "services": {}, "bootstrap": {}}
    for label, (unit, config_dir, state_dir) in SERVICES.items():
        output["services"][label] = {"service": inspect_service(unit, fixture),
            "configuration": inspect_configuration(rooted(root, config_dir + "/runtime.json"), root),
            "records": {key: inspect_database(rooted(root, state_dir + "/" + suffix), table)
                        for key, (suffix, table) in DATABASES.items()}}
    output["services"]["usd"]["accountEnvironment"] = inspect_account_environment(
        rooted(root, "/etc/kai-koin-prepaid/account.env"))
    for label, directory in (("legacy", "/root/kai-mainnet-bootstrap"), ("usd", "/root/kai-prepaid-usd-bootstrap")):
        output["bootstrap"][label] = inspect_configuration(rooted(root, directory + "/plan.json"), root)
    endpoints = {"legacyLocal": ("http://127.0.0.1:3108/health", False),
                 "usdLocal": ("http://127.0.0.1:3109/health", False),
                 "legacyHttps": ("https://payments.koinosai.com/health", False),
                 "usdHttps": ("https://credits.koinosai.com/health", False),
                 "usdSignup": ("https://credits.koinosai.com/auth/methods", True)}
    if offline or fixture:
        output["endpoints"] = {key: {"state": "not-queried"} for key in endpoints}
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            futures = {key: executor.submit(inspect_endpoint, *args) for key, args in endpoints.items()}
            output["endpoints"] = {key: future.result() for key, future in futures.items()}
    usd = output["services"]["usd"]["configuration"]
    remaining = []
    if usd.get("product") != "prepaid-usd-v1":
        remaining.append("Prepare and deploy the separate USD product; preserve legacy records")
    if not usd.get("publicAccounts") or not output["endpoints"]["usdSignup"].get("canCreateAccount"):
        remaining.append("Configure and verify signup on the separate credit service origin")
    if not all(usd.get("tariffUsdAtomsPerMillion", {}).get(k) for k in ("input", "output")):
        remaining.append("Set the initial model's explicit USD input and output tariffs")
    if not usd.get("purchasePricing", {}).get("present"):
        remaining.append("Configure the reviewed Uniswap v4 pricing policy and current evidence")
    remaining.append("Verify live purchase pricing, on-chain code/policy pins and role Mana; presence checks are insufficient")
    if not usd.get("freePolicy", {}).get("present"):
        remaining.append("Set the explicit daily free-credit policy and matching funded contract sponsorship")
    if not usd.get("automaticQualificationConfigured"):
        remaining.append("Configure reviewed automatic model qualification and run fresh provider checks")
    remaining += ["Publish Test with verified USD service pins and test normal Buy credits / Chat on two computers",
                  "Verify 10000 KOIN reward seed and Master daily allocation, then observe three closed reward days and payouts",
                  "Resolve legacy obligations from their saved records; this report never retries or clears them"]
    output["remaining"] = remaining
    output["limits"] = ["No keys, account identifiers, prompts, signatures or credential values are included",
                        "Known paths only; missing is not proof that no deployment exists elsewhere",
                        "Local snapshots can lag the running service; unknown states need follow-up",
                        "Pricing, signature validity, on-chain balances and funding were not verified"]
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Skip all HTTP reads")
    parser.add_argument("--fixture-root", type=Path, help="Inspect a test directory; disables systemctl and HTTP")
    args = parser.parse_args()
    print(json.dumps(report(args.fixture_root.resolve() if args.fixture_root else Path("/"), args.offline), indent=2))
