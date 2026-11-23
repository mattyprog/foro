"""Dettagli di un'attivita' dal suo file FIT originale (SDK ufficiale garmin-fit-sdk).

Stesse regole di src/lib/fit/parseFit.ts:
- giri dai messaggi 'lap' (non per la forza);
- traccia dai 'record' con GPS: taglio privacy, poi Douglas-Peucker fino a 500 punti;
- serie FC e passo dai 'record', sottocampionate fino a 600 punti;
- serie di forza dai messaggi 'set' attivi, con categoria e nome Garmin leggibili.
"""

from __future__ import annotations

import io
import zipfile
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from garmin_fit_sdk import Decoder, Profile, Stream

from . import geo
from .normalize import as_int, as_round, clean, exercise_key, exercise_set, num

SEMICIRCLE_TO_DEG = 180.0 / 2**31
MAX_FIT_BYTES = 50 * 1024 * 1024


class FitError(Exception):
    """File FIT assente, illeggibile o vuoto (messaggio sempre generico)."""


def extract_fit(data: bytes) -> bytes:
    """Il download Garmin e' uno ZIP con il file originale: estrae il primo .fit (o accetta un FIT nudo)."""
    if len(data) >= 12 and data[8:12] == b".FIT":
        return data
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if info.filename.lower().endswith(".fit") and info.file_size <= MAX_FIT_BYTES:
                    return z.read(info)
    except zipfile.BadZipFile as exc:
        raise FitError("non e' uno ZIP ne' un FIT") from exc
    raise FitError("nessun file FIT nello ZIP")


def _first(value: Any) -> Any:
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _seconds(ts: Any, start: datetime) -> float | None:
    if isinstance(ts, datetime):
        return (ts - start).total_seconds()
    return None


def _exercise_name_key(category: str | None, subtype: Any) -> str | None:
    """category 'bench_press' + sottotipo 1 -> 'BARBELL_BENCH_PRESS' (dal profilo FIT)."""
    sub = as_int(_first(subtype), non_negative=True)
    if not category or sub is None:
        return None
    table = Profile["types"].get(f"{category}_exercise_name")
    if not isinstance(table, Mapping):
        return None
    return exercise_key(table.get(sub))


def decode(data: bytes) -> dict[str, list[dict[str, Any]]]:
    fit = extract_fit(data)
    if not Decoder(Stream.from_byte_array(bytearray(fit))).is_fit():
        raise FitError("intestazione FIT non valida")
    try:
        messages, _errors = Decoder(Stream.from_byte_array(bytearray(fit))).read(
            convert_types_to_strings=True,
            convert_datetimes_to_dates=True,
            merge_heart_rates=True,
        )
    except Exception as exc:  # l'SDK puo' sollevare errori generici su file troncati
        raise FitError("decodifica FIT non riuscita") from exc
    if not messages:
        raise FitError("file FIT vuoto")
    return messages


def parse_fit_details(data: bytes, *, kind: str, privacy_trim_m: float = 300.0) -> dict[str, Any]:
    """Restituisce solo i campi di dettaglio dell'Activity: laps, track, hrSeries, paceSeries, exerciseSets."""
    messages = decode(data)
    sessions = messages.get("session_mesgs") or []
    records = messages.get("record_mesgs") or []
    session = sessions[0] if sessions else {}

    start = session.get("start_time")
    if not isinstance(start, datetime):
        stamps: list[datetime] = [ts for r in records if isinstance(ts := r.get("timestamp"), datetime)]
        start = min(stamps) if stamps else None

    track_raw: list[list[float]] = []
    hr: list[list[float]] = []
    speeds: list[list[float]] = []
    for rec in records:
        lat, lon = rec.get("position_lat"), rec.get("position_long")
        if isinstance(lat, int) and isinstance(lon, int):
            dlat, dlon = lat * SEMICIRCLE_TO_DEG, lon * SEMICIRCLE_TO_DEG
            if geo.is_valid_coord(dlat, dlon):
                track_raw.append([dlat, dlon])
        if start is None:
            continue
        t = _seconds(rec.get("timestamp"), start)
        if t is None or t < 0:
            continue
        bpm = as_int(rec.get("heart_rate"), positive=True)
        if bpm is not None and bpm < 250:
            hr.append([t, bpm])
        speed = num(rec.get("enhanced_speed"))
        if speed is None:
            speed = num(rec.get("speed"))
        if speed is not None:
            speeds.append([t, speed])

    details: dict[str, Any] = {}
    if kind != "forza":
        laps = []
        for lap in messages.get("lap_mesgs") or []:
            duration = num(lap.get("total_timer_time"))
            if duration is None:
                duration = num(lap.get("total_elapsed_time"))
            if not duration or duration <= 0:
                continue
            distance = as_int(lap.get("total_distance"), positive=True)
            speed = num(lap.get("enhanced_avg_speed"))
            if speed is None:
                speed = num(lap.get("avg_speed"))
            pace = int(round(1000.0 / speed)) if distance and speed and speed >= geo.MIN_SPEED_MS else None
            laps.append(
                clean(
                    {
                        "durationSec": int(round(duration)),
                        "distanceM": distance,
                        "avgHr": as_int(lap.get("avg_heart_rate"), positive=True),
                        "avgPaceSecPerKm": pace,
                    }
                )
            )
        if laps:
            details["laps"] = laps
        track = geo.simplify_track(geo.trim_privacy(track_raw, privacy_trim_m), geo.MAX_TRACK_POINTS)
        if len(track) >= 2:
            details["track"] = track
        pace_series = geo.speed_series_to_pace(speeds, geo.MAX_SERIES_POINTS)
        if pace_series:
            details["paceSeries"] = pace_series
    if hr:
        details["hrSeries"] = geo.downsample_pairs(hr, geo.MAX_SERIES_POINTS)

    sets = []
    for s in messages.get("set_mesgs") or []:
        if str(s.get("set_type") or "active").lower() != "active":
            continue
        raw_cat = _first(s.get("category"))
        category = raw_cat if isinstance(raw_cat, str) and raw_cat != "unknown" else None
        sets.append(
            exercise_set(
                exercise_key(category),
                _exercise_name_key(category, s.get("category_subtype")),
                reps=s.get("repetitions"),
                kg=as_round(s.get("weight"), 2, positive=True),
                duration=s.get("duration"),
            )
        )
    if sets:
        details["exerciseSets"] = sets
    return details
