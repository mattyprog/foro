"""Geometria delle tracce GPS e delle serie temporali.

Le stesse regole sono implementate in src/lib/fit/geo.ts: se ne cambi una, cambia anche l'altra.
- Taglio privacy: via i primi e gli ultimi `trim_m` metri di percorso E ogni punto a meno di
  `trim_m` metri (in linea d'aria) dal punto di partenza o di arrivo, cosi' casa non si vede
  nemmeno se il giro ci ripassa vicino.
- Douglas-Peucker con tolleranza crescente finche' i punti sono al massimo `max_points`.
- Serie [secondi, valore] sottocampionate per medie su blocchi consecutivi.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

EARTH_RADIUS_M = 6_371_008.8
COORD_DECIMALS = 5  # circa 1 m
# Sotto questa velocita' (m/s) si considera fermo: niente passo (sarebbe oltre 33 min/km).
MIN_SPEED_MS = 0.5
MAX_TRACK_POINTS = 500
MAX_SERIES_POINTS = 600

Point = Sequence[float]


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def is_valid_coord(lat: object, lon: object) -> bool:
    return (
        isinstance(lat, (int, float))
        and isinstance(lon, (int, float))
        and math.isfinite(lat)
        and math.isfinite(lon)
        and -90 <= lat <= 90
        and -180 <= lon <= 180
        and not (lat == 0 and lon == 0)
    )


def trim_privacy(points: Sequence[Point], trim_m: float) -> list[list[float]]:
    """Toglie inizio e fine della traccia (vedi docstring del modulo). Restituisce [] se resta poco."""
    pts = [[float(p[0]), float(p[1])] for p in points]
    if trim_m <= 0:
        return pts
    if len(pts) < 2:
        return []
    cumulative = [0.0]
    for a, b in zip(pts, pts[1:]):
        cumulative.append(cumulative[-1] + haversine_m(a[0], a[1], b[0], b[1]))
    total = cumulative[-1]
    if total <= 2 * trim_m:
        return []
    start, end = pts[0], pts[-1]
    out = []
    for p, dist in zip(pts, cumulative):
        if dist < trim_m or dist > total - trim_m:
            continue
        if haversine_m(start[0], start[1], p[0], p[1]) < trim_m:
            continue
        if haversine_m(end[0], end[1], p[0], p[1]) < trim_m:
            continue
        out.append(p)
    return out if len(out) >= 2 else []


def _norm(x: float, y: float) -> float:
    # sqrt(x*x + y*y) e non math.hypot: hypot ha precisione diversa tra Python e JavaScript
    return math.sqrt(x * x + y * y)


def _segment_distance(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return _norm(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return _norm(px - (ax + t * dx), py - (ay + t * dy))


def _douglas_peucker(xy: list[tuple[float, float]], eps: float) -> list[int]:
    """Indici dei punti tenuti (iterativo, niente ricorsione)."""
    n = len(xy)
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        first, last = stack.pop()
        if last - first < 2:
            continue
        ax, ay = xy[first]
        bx, by = xy[last]
        best, best_i = -1.0, -1
        for i in range(first + 1, last):
            d = _segment_distance(xy[i][0], xy[i][1], ax, ay, bx, by)
            if d > best:
                best, best_i = d, i
        if best > eps:
            keep[best_i] = True
            stack.append((first, best_i))
            stack.append((best_i, last))
    return [i for i in range(n) if keep[i]]


def _round_dedupe(points: Sequence[Point]) -> list[list[float]]:
    out: list[list[float]] = []
    for p in points:
        q = [round(p[0], COORD_DECIMALS), round(p[1], COORD_DECIMALS)]
        if not out or out[-1] != q:
            out.append(q)
    return out


def simplify_track(points: Sequence[Point], max_points: int = MAX_TRACK_POINTS) -> list[list[float]]:
    """Douglas-Peucker in metri (proiezione locale), tolleranza da 1 m in su finche' bastano i punti."""
    pts = [[float(p[0]), float(p[1])] for p in points if is_valid_coord(p[0], p[1])]
    if len(pts) <= 2:
        return _round_dedupe(pts)
    lat0 = math.radians(sum(p[0] for p in pts) / len(pts))
    k = math.pi / 180 * EARTH_RADIUS_M
    xy = [((p[1] * math.cos(lat0)) * k, p[0] * k) for p in pts]
    eps = 1.0
    out: list[list[float]] = _round_dedupe(pts)
    for _ in range(80):
        idx = _douglas_peucker(xy, eps)
        out = _round_dedupe([pts[i] for i in idx])
        if len(out) <= max_points:
            return out
        eps *= 1.5
    return out[: max_points - 1] + [out[-1]]


def downsample_pairs(
    series: Sequence[Sequence[float]],
    max_points: int = MAX_SERIES_POINTS,
    *,
    round_values: bool = True,
) -> list[list[float]]:
    """Riduce [[t, v], ...] a max_points con la media di blocchi consecutivi di campioni."""
    n = len(series)

    def fmt(t: float, v: float) -> list[float]:
        return [int(round(t)), int(round(v)) if round_values else v]

    if n <= max_points:
        return [fmt(t, v) for t, v in series]
    out = []
    for i in range(max_points):
        a = (i * n) // max_points
        b = ((i + 1) * n) // max_points
        block = series[a:b]
        if not block:
            continue
        t = sum(p[0] for p in block) / len(block)
        v = sum(p[1] for p in block) / len(block)
        out.append(fmt(t, v))
    return out


def speed_series_to_pace(
    speeds: Sequence[Sequence[float]], max_points: int = MAX_SERIES_POINTS
) -> list[list[int]]:
    """[[t, m/s], ...] -> [[t, s/km], ...]: media delle velocita' per blocco, poi passo."""
    moving = [[t, v] for t, v in speeds if v is not None and v >= MIN_SPEED_MS]
    reduced = downsample_pairs(moving, max_points, round_values=False)
    return [[int(t), int(round(1000.0 / v))] for t, v in reduced if v >= MIN_SPEED_MS]
