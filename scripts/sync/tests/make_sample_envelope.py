"""Genera tests/fixtures/garmin-envelope.sample.json: una busta VERA prodotta da questo script Python
con dati SINTETICI (server finto) e la password di test, che il modulo TypeScript deve saper decifrare.

Uso (dalla radice del repository):
    scripts/sync/.venv/Scripts/python scripts/sync/tests/make_sample_envelope.py      (Windows)
    scripts/sync/.venv/bin/python scripts/sync/tests/make_sample_envelope.py          (Linux/macOS)

Il test test_sample_fixture.py verifica che la busta salvata corrisponda ancora a quanto produce lo script.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import helpers  # noqa: E402
from fake_garmin import FAKE_API_KEY, FakeGarmin  # noqa: E402

from garmin_bridge.api import GarminApi  # noqa: E402
from garmin_bridge.envelope import encrypt_json  # noqa: E402
from garmin_bridge.sync import SyncOptions, run_sync  # noqa: E402

SAMPLE_PATH = helpers.REPO_ROOT / "tests" / "fixtures" / "garmin-envelope.sample.json"
SAMPLE_TODAY = date(2026, 11, 20)
SAMPLE_NOW = datetime(2026, 11, 20, 9, 23, tzinfo=UTC)


def build_sample_bundle() -> dict:
    fake = FakeGarmin(SAMPLE_TODAY)
    with GarminApi(FAKE_API_KEY, session=fake, sleep=lambda _s: None, polite_delay=0) as api:
        api.connect()
        bundle, _ = run_sync(api, None, SyncOptions(), today=SAMPLE_TODAY, now=SAMPLE_NOW)
    return bundle


def main() -> int:
    bundle = build_sample_bundle()
    envelope = encrypt_json(bundle, helpers.TEST_PASSPHRASE, generated_at=bundle["generatedAt"])
    SAMPLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    SAMPLE_PATH.write_text(json.dumps(envelope, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"scritta {SAMPLE_PATH.relative_to(helpers.REPO_ROOT)} ({SAMPLE_PATH.stat().st_size} byte)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
