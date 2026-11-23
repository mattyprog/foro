"""La busta di esempio usata dal test TypeScript e' stata prodotta da questo script ed e' aggiornata."""

from __future__ import annotations

import json
import unittest

import helpers  # noqa: F401
from helpers import TEST_PASSPHRASE
from make_sample_envelope import SAMPLE_PATH, build_sample_bundle

from garmin_bridge.envelope import decrypt_json


class SampleFixtureTest(unittest.TestCase):
    def test_busta_di_esempio_aggiornata(self):
        self.assertTrue(SAMPLE_PATH.exists(), "manca la busta di esempio: lancia scripts/sync/tests/make_sample_envelope.py")
        envelope = json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))
        self.assertEqual(envelope["iter"], 600_000)
        self.assertEqual(
            decrypt_json(envelope, TEST_PASSPHRASE),
            build_sample_bundle(),
            "la busta di esempio non corrisponde piu' allo script: rigenerala con scripts/sync/tests/make_sample_envelope.py",
        )


if __name__ == "__main__":
    unittest.main()
