#!/usr/bin/env python3
"""Meaningful checks for operator-report redaction and live-state preservation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

MODULE = Path(__file__).with_name("koin-credit-activation-preflight.py")
spec = importlib.util.spec_from_file_location("preflight", MODULE)
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class PreflightTest(unittest.TestCase):
    def test_missing_installation_does_not_create_service_state(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            value = preflight.report(root)
            self.assertEqual(list(root.iterdir()), [])
            self.assertEqual(value["services"]["usd"]["configuration"]["state"], "missing")
            self.assertFalse(value["productionAcceptance"])
            self.assertTrue(any("free-credit" in item for item in value["remaining"]))

    def test_configuration_does_not_echo_credentials_addresses_or_errors(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            runtime = root / "etc/kai-koin-prepaid/runtime.json"
            runtime.parent.mkdir(parents=True)
            secret = "SENSITIVE-CREDENTIAL-DO-NOT-PRINT"
            runtime.write_text(json.dumps({
                "deployment": {"product": "prepaid-usd-v1", "masterNode": preflight.EXPECTED_MASTER,
                               "credits": "PRIVATE-ACCOUNT", "rewards": "PRIVATE-ACCOUNT",
                               "creditsHash": "hash", "rewardsHash": "hash", "chainId": "chain"},
                "accountMode": "public", "tariff": {"inputAtomsPerMillion": "10000000", "outputAtomsPerMillion": "30000000"},
                "purchasePricing": {"rpcUrls": ["https://rpc.example/"+secret, "https://two.example/?key="+secret],
                                    "parityFile": "/etc/kai-koin-prepaid/parity.json", "paritySigner": "PRIVATE-ACCOUNT"},
                "operator-secret": secret, "privateKey": secret,
            }))
            parity = runtime.with_name("parity.json")
            parity.write_text(secret)
            account_env = runtime.with_name("account.env")
            account_env.write_text("SMTP_PASS=" + secret)
            account_env.chmod(0o600)
            value = preflight.report(root)
            printed = json.dumps(value)
            for forbidden in (secret, "PRIVATE-ACCOUNT", preflight.EXPECTED_MASTER, "rpc.example", "privateKey"):
                self.assertNotIn(forbidden, printed)
            self.assertTrue(value["services"]["usd"]["configuration"]["masterDestinationMatches"])
            self.assertEqual(value["services"]["usd"]["accountEnvironment"]["state"], "present-not-read")
            self.assertTrue(value["services"]["usd"]["accountEnvironment"]["ownerOnlyPermissions"])
            self.assertEqual(value["services"]["usd"]["configuration"]["purchasePricing"]["localParityFile"], "present-not-read")

    def test_readonly_wal_snapshot_preserves_live_files_and_redacts_state(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "test-signing.sqlite"
            db = sqlite3.connect(path)
            try:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE signatures(id TEXT, owner TEXT, state TEXT, data TEXT)")
                db.executemany("INSERT INTO signatures VALUES(?,?,?,?)", [
                    ("PRIVATE-ID", "PRIVATE-WALLET", "signed", "PRIVATE-SIGNATURE"),
                    ("PRIVATE-ID2", "PRIVATE-WALLET", "SENSITIVE-STATE", "PRIVATE-CHAT"),
                ])
                db.commit()
                before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in path.parent.iterdir()}
                value = preflight.inspect_database(path, "signatures")
                after = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in path.parent.iterdir()}
                self.assertEqual(before, after)
                self.assertEqual(value["state"], "read-snapshot")
                self.assertEqual(value["counts"], {"signed": 1, "other": 1})
                self.assertNotIn("PRIVATE", json.dumps(value))
                self.assertNotIn("SENSITIVE", json.dumps(value))
            finally:
                db.close()

    def test_corrupt_files_and_symlinks_do_not_expose_contents(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / "private.json"
            target.write_text("SECRET-ERROR-CONTENT")
            self.assertEqual(preflight.inspect_database(target, "signatures")["state"], "unreadable-snapshot")
            link = root / "runtime.json"
            link.symlink_to(target)
            self.assertEqual(preflight.inspect_configuration(link, root), {"state": "symlink-refused"})


if __name__ == "__main__":
    unittest.main()
