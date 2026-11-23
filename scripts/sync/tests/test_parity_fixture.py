"""La fixture di parita' Python/TypeScript e' stata prodotta da questo codice ed e' aggiornata."""

from __future__ import annotations

import json
import unittest

import helpers  # noqa: F401
from make_parity_fixture import PARITY_PATH, build_parity_fixture


class ParityFixtureTest(unittest.TestCase):
    def test_fixture_di_parita_aggiornata(self):
        self.assertTrue(PARITY_PATH.exists(), "manca la fixture: lancia scripts/sync/tests/make_parity_fixture.py")
        saved = json.loads(PARITY_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            saved,
            build_parity_fixture(),
            "la fixture di parita' non corrisponde piu' al codice Python: rigenerala con "
            "scripts/sync/tests/make_parity_fixture.py e verifica il TypeScript (src/lib/fit/parity.test.ts)",
        )

    def test_la_fixture_esercita_davvero_le_regole(self):
        expected = build_parity_fixture()["expected"]
        self.assertLessEqual(len(expected["track"]), 120)
        self.assertGreater(len(expected["track"]), 20)
        self.assertEqual(len(expected["hrSeries"]), 600)
        self.assertGreater(len(expected["paceSeries"]), 500)
        self.assertEqual([s["category"] for s in expected["fit"]["strength"]["exerciseSets"]], ["BENCH_PRESS", "SQUAT"])
        self.assertEqual(len(expected["fit"]["run"]["laps"]), 3)


if __name__ == "__main__":
    unittest.main()
