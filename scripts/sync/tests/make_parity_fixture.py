"""Genera tests/fixtures/fit-parity.sample.json: file FIT, traccia e serie SINTETICI con i risultati
calcolati dal codice Python (fitparse.py e geo.py).

Il test TypeScript src/lib/fit/parity.test.ts deve ottenere esattamente gli stessi numeri: le regole
(taglio privacy, Douglas-Peucker, sottocampionamento, arrotondamenti, serie di forza) vivono in due
linguaggi e questa fixture le tiene allineate. Il test test_parity_fixture.py verifica che la fixture
corrisponda ancora al codice Python: se cambi una regola, rigenerala e aggiorna anche il TypeScript.

Uso (dalla radice del repository):
    scripts/sync/.venv/Scripts/python scripts/sync/tests/make_parity_fixture.py      (Windows)
    scripts/sync/.venv/bin/python scripts/sync/tests/make_parity_fixture.py          (Linux/macOS)
"""

from __future__ import annotations

import base64
import json
import math
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import helpers  # noqa: E402
from synthetic_fit import run_fit, strength_fit  # noqa: E402

from garmin_bridge import geo  # noqa: E402
from garmin_bridge.fitparse import parse_fit_details  # noqa: E402

PARITY_PATH = helpers.REPO_ROOT / "tests" / "fixtures" / "fit-parity.sample.json"
# Sede Garmin a Olathe (Kansas): un luogo pubblico qualsiasi, nessun dato reale.
LAT0, LON0 = 38.8556, -94.799
TRIM_M = 300
TRACK_MAX = 120


def parity_track() -> list[list[float]]:
    """Spirale verso l'esterno e poi rientro quasi fino alla partenza (passa vicino a 'casa')."""
    pts: list[tuple[float, float]] = []
    for i in range(900):
        a = i / 25
        r = 0.0005 + i * 0.000012
        pts.append((LAT0 + r * math.sin(a), LON0 + r * math.cos(a) * 1.28))
    last = pts[-1]
    for j in range(1, 301):
        f = 0.97 * j / 300
        pts.append((last[0] + (LAT0 - last[0]) * f, last[1] + (LON0 - last[1]) * f))
    return [[round(a, 7), round(b, 7)] for a, b in pts]


def parity_series() -> tuple[list[list[float]], list[list[float]]]:
    """Serie con medie che cadono a metà (arrotondamento) e tratti da fermo (niente passo)."""
    hr = [[t + (0.5 if t % 3 == 0 else 0.0), 100 + (t * 7) % 60] for t in range(1801)]
    speeds = [[float(t), 2.0 + ((t * 13) % 20) / 10 if t % 97 else 0.2] for t in range(1801)]
    return hr, speeds


def build_parity_fixture() -> dict[str, Any]:
    track = parity_track()
    hr, speeds = parity_series()
    run, strength = run_fit(), strength_fit(with_sets=True)
    trimmed = geo.trim_privacy(track, TRIM_M)
    fixture = {
        "input": {
            "trimM": TRIM_M,
            "trackMax": TRACK_MAX,
            "track": track,
            "hr": hr,
            "speeds": speeds,
            "fit": {
                "run": base64.b64encode(run).decode("ascii"),
                "strength": base64.b64encode(strength).decode("ascii"),
            },
        },
        "expected": {
            "trimmedCount": len(trimmed),
            "track": geo.simplify_track(trimmed, TRACK_MAX),
            "trackUntrimmed": geo.simplify_track(track, geo.MAX_TRACK_POINTS),
            "hrSeries": geo.downsample_pairs(hr, geo.MAX_SERIES_POINTS),
            "paceSeries": geo.speed_series_to_pace(speeds, geo.MAX_SERIES_POINTS),
            "fit": {
                "run": parse_fit_details(run, kind="corsa", privacy_trim_m=TRIM_M),
                "strength": parse_fit_details(strength, kind="forza", privacy_trim_m=TRIM_M),
            },
        },
    }
    # passaggio da JSON: tuple -> liste, come nel file salvato
    return json.loads(json.dumps(fixture))


def main() -> int:
    fixture = build_parity_fixture()
    PARITY_PATH.parent.mkdir(parents=True, exist_ok=True)
    PARITY_PATH.write_text(json.dumps(fixture, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    print(f"scritta {PARITY_PATH.relative_to(helpers.REPO_ROOT)} ({PARITY_PATH.stat().st_size} byte)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
