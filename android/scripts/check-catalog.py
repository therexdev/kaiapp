"""Fail if Android's model identities drift from the desktop catalog."""
import json
from pathlib import Path

android = Path(__file__).resolve().parents[1]
desktop = json.loads((android.parent / "core/models/catalog.json").read_text())
mobile = json.loads((android / "app/src/main/assets/models.json").read_text())
for model in mobile:
    package = desktop["packages"][desktop["aliases"][model["id"]]["package"]]
    for key in ("filename", "url", "sha256", "sizeBytes", "license"):
        assert model[key] == package[key], f"{model['id']}: {key} drifted"
    assert model["url"].startswith("https://huggingface.co/")
    assert len(model["sha256"]) == 64
print(f"PASS: {len(mobile)} model identities match desktop")
