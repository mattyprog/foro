"""Geometria delle tracce: taglio privacy, Douglas-Peucker, sottocampionamento delle serie."""

from __future__ import annotations

import math
import unittest

import helpers  # noqa: F401

from garmin_bridge.geo import (
    downsample_pairs,
    haversine_m,
    simplify_track,
    speed_series_to_pace,
    trim_privacy,
)

# Punto di partenza sintetico: sede Garmin a Olathe (Kansas), luogo pubblico.
LAT0, LON0 = 38.8556, -94.7990


def straight_line(n: int, step_m: float, bearing_deg: float = 0.0) -> list[list[float]]:
    """n punti in linea retta, distanziati step_m metri."""
    pts = []
    for i in range(n):
        d = i * step_m
        dlat = d * math.cos(math.radians(bearing_deg)) / 111_195.0
        dlon = d * math.sin(math.radians(bearing_deg)) / (111_195.0 * math.cos(math.radians(LAT0)))
        pts.append([LAT0 + dlat, LON0 + dlon])
    return pts


def path_length(pts: list[list[float]]) -> float:
    return sum(haversine_m(a[0], a[1], b[0], b[1]) for a, b in zip(pts, pts[1:]))


class HaversineTest(unittest.TestCase):
    def test_un_grado_di_latitudine(self):
        self.assertAlmostEqual(haversine_m(0, 0, 1, 0), 111_195, delta=5)

    def test_distanza_nulla(self):
        self.assertEqual(haversine_m(LAT0, LON0, LAT0, LON0), 0)


class TrimPrivacyTest(unittest.TestCase):
    def test_taglia_inizio_e_fine(self):
        pts = straight_line(301, 10.0)  # 3 km in linea retta
        out = trim_privacy(pts, 300)
        self.assertTrue(out)
        start, end = pts[0], pts[-1]
        for p in out:
            self.assertGreaterEqual(haversine_m(start[0], start[1], p[0], p[1]), 300 - 1e-6)
            self.assertGreaterEqual(haversine_m(end[0], end[1], p[0], p[1]), 300 - 1e-6)
        self.assertAlmostEqual(path_length(out), 2400, delta=25)

    def test_traccia_troppo_corta_sparisce(self):
        self.assertEqual(trim_privacy(straight_line(50, 10.0), 300), [])

    def test_giro_che_ripassa_vicino_a_casa(self):
        # andata 1 km verso nord, ritorno fino alla partenza, poi 1 km verso est:
        # il passaggio da casa a meta' giro va tolto anche se lontano in distanza percorsa.
        out_leg = straight_line(101, 10.0, 0)
        back = list(reversed(straight_line(96, 10.0, 0)))
        east = [[p[0], p[1]] for p in straight_line(101, 10.0, 90)]
        pts = out_leg + back + east
        trimmed = trim_privacy(pts, 300)
        for p in trimmed:
            self.assertGreaterEqual(haversine_m(LAT0, LON0, p[0], p[1]), 300 - 1e-6)

    def test_zero_non_taglia(self):
        pts = straight_line(10, 10.0)
        self.assertEqual(trim_privacy(pts, 0), pts)


class SimplifyTest(unittest.TestCase):
    def test_linea_retta_si_riduce_a_due_punti(self):
        out = simplify_track(straight_line(1000, 3.0), 500)
        self.assertEqual(len(out), 2)

    def test_rispetta_il_massimo_di_punti(self):
        # spirale fitta: tanti punti significativi
        pts = []
        for i in range(5000):
            a = i / 40.0
            r = 0.002 + i * 0.000001
            pts.append([LAT0 + r * math.sin(a), LON0 + r * math.cos(a)])
        out = simplify_track(pts, 500)
        self.assertLessEqual(len(out), 500)
        self.assertGreater(len(out), 50)
        self.assertEqual(out[0], [round(pts[0][0], 5), round(pts[0][1], 5)])
        self.assertEqual(out[-1], [round(pts[-1][0], 5), round(pts[-1][1], 5)])

    def test_coordinate_arrotondate(self):
        out = simplify_track([[38.123456789, -94.987654321], [38.2, -94.9]], 500)
        self.assertEqual(out[0], [38.12346, -94.98765])


class DownsampleTest(unittest.TestCase):
    def test_serie_corta_invariata(self):
        series = [[i, 100 + i] for i in range(10)]
        self.assertEqual(downsample_pairs(series, 600), series)

    def test_serie_lunga_ridotta_con_media(self):
        series = [[i, 120 if i % 2 else 140] for i in range(3600)]
        out = downsample_pairs(series, 600)
        self.assertEqual(len(out), 600)
        self.assertTrue(all(v == 130 for _, v in out))
        self.assertTrue(all(out[i][0] < out[i + 1][0] for i in range(len(out) - 1)))

    def test_passo_dalla_velocita_media(self):
        # 3,33 m/s = 5:00/km; i punti da fermo (velocita' bassa) non entrano nel passo
        speeds = [[i, 1000 / 300] for i in range(100)] + [[100, 0.1]]
        pace = speed_series_to_pace(speeds, 600)
        self.assertEqual(len(pace), 100)
        self.assertTrue(all(p == 300 for _, p in pace))


if __name__ == "__main__":
    unittest.main()
