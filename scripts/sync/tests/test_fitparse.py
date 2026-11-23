"""Dettagli dai file FIT: giri, traccia (con taglio privacy), serie FC/passo, serie di forza."""

from __future__ import annotations

import unittest

import helpers  # noqa: F401
from synthetic_fit import BENCH_NAME, SQUAT_NAME, START_LAT, START_LON, run_fit, strength_fit, zipped

from garmin_bridge.fitparse import FitError, extract_fit, parse_fit_details
from garmin_bridge.geo import haversine_m


class FitParseRunTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.details = parse_fit_details(zipped(run_fit()), kind="corsa", privacy_trim_m=300)

    def test_giri(self):
        laps = self.details["laps"]
        self.assertEqual(len(laps), 3)
        self.assertEqual(laps[0], {"durationSec": 300, "distanceM": 1000, "avgHr": 130, "avgPaceSecPerKm": 300})

    def test_traccia_semplificata_e_tagliata(self):
        track = self.details["track"]
        self.assertGreaterEqual(len(track), 2)
        self.assertLessEqual(len(track), 500)
        for lat, lon in track:
            self.assertGreaterEqual(haversine_m(START_LAT, START_LON, lat, lon), 299)
        # la fine della corsa (3 km piu' avanti) e' lontana almeno 300 m dall'ultimo punto tenuto
        end_lat, end_lon = track[-1]
        self.assertLess(haversine_m(START_LAT, START_LON, end_lat, end_lon), 2750)

    def test_serie_fc_e_passo(self):
        hr = self.details["hrSeries"]
        pace = self.details["paceSeries"]
        self.assertLessEqual(len(hr), 600)
        self.assertLessEqual(len(pace), 600)
        self.assertEqual(hr[0][0], 0)
        self.assertGreaterEqual(hr[-1][0], 890)
        self.assertTrue(120 <= hr[0][1] <= 125)
        self.assertTrue(all(p == 300 for _, p in pace))

    def test_niente_serie_di_forza(self):
        self.assertNotIn("exerciseSets", self.details)


class FitParseStrengthTest(unittest.TestCase):
    def test_serie_di_forza_con_nomi_leggibili(self):
        details = parse_fit_details(strength_fit(), kind="forza")
        self.assertEqual(
            details["exerciseSets"],
            [
                {"name": BENCH_NAME.replace("_", " ").capitalize(), "category": "BENCH_PRESS", "reps": 10, "kg": 60.0, "durationSec": 40},
                {"name": SQUAT_NAME.replace("_", " ").capitalize(), "category": "SQUAT", "reps": 8, "kg": 80.0, "durationSec": 45},
            ],
        )
        self.assertNotIn("track", details)
        self.assertNotIn("paceSeries", details)
        self.assertNotIn("laps", details)  # i giri di una seduta di forza non servono
        self.assertTrue(details["hrSeries"])


class FitParseErrorsTest(unittest.TestCase):
    def test_file_non_fit(self):
        with self.assertRaises(FitError):
            parse_fit_details(b"questo non e' un file FIT", kind="corsa")

    def test_zip_senza_fit(self):
        import io
        import zipfile

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("leggimi.txt", "niente")
        with self.assertRaises(FitError):
            extract_fit(buf.getvalue())

    def test_corsa_su_tapis_roulant_senza_gps(self):
        details = parse_fit_details(run_fit(gps=False, sub_sport="treadmill"), kind="corsa")
        self.assertNotIn("track", details)
        self.assertEqual(len(details["laps"]), 3)


if __name__ == "__main__":
    unittest.main()
