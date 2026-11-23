"""File FIT SINTETICI costruiti con l'Encoder ufficiale (garmin-fit-sdk), solo per i test.

Le coordinate partono dalla sede Garmin di Olathe (Kansas), un luogo pubblico qualsiasi.
"""

from __future__ import annotations

import io
import math
import zipfile
from datetime import UTC, datetime, timedelta

import helpers  # noqa: F401
from garmin_fit_sdk import Encoder, Profile

MESG = {name: num for num, name in Profile["types"]["mesg_num"].items()}
SEMICIRCLES_PER_DEGREE = 2**31 / 180.0
START_LAT, START_LON = 38.8556, -94.7990


def _semi(deg: float) -> int:
    return int(round(deg * SEMICIRCLES_PER_DEGREE))


def run_fit(
    start: datetime = datetime(2026, 11, 18, 6, 30, 5, tzinfo=UTC),
    *,
    km: float = 3.0,
    pace_s_per_km: float = 300.0,
    gps: bool = True,
    sub_sport: str = "street",
) -> bytes:
    """Corsa in linea quasi retta verso nord-est: 1 record al secondo, FC in salita, giri da 1 km."""
    speed = 1000.0 / pace_s_per_km
    seconds = int(round(km * pace_s_per_km))
    enc = Encoder()
    enc.on_mesg(MESG["file_id"], {"type": "activity", "manufacturer": "development", "product": 1, "time_created": start, "serial_number": 4242})
    enc.on_mesg(MESG["event"], {"timestamp": start, "event": "timer", "event_type": "start"})
    for s in range(seconds + 1):
        dist = s * speed
        dlat = dist * math.cos(math.radians(30)) / 111_195.0
        dlon = dist * math.sin(math.radians(30)) / (111_195.0 * math.cos(math.radians(START_LAT)))
        rec = {
            "timestamp": start + timedelta(seconds=s),
            "heart_rate": 120 + int(40 * s / seconds),
            "distance": dist,
            "enhanced_speed": speed,
            "cadence": 83,
        }
        if gps:
            rec["position_lat"] = _semi(START_LAT + dlat)
            rec["position_long"] = _semi(START_LON + dlon)
        enc.on_mesg(MESG["record"], rec)
    laps = int(math.ceil(km))
    for i in range(laps):
        lap_km = min(1.0, km - i)
        dur = lap_km * pace_s_per_km
        lap_start = start + timedelta(seconds=i * pace_s_per_km)
        enc.on_mesg(
            MESG["lap"],
            {
                "message_index": i,
                "timestamp": lap_start + timedelta(seconds=dur),
                "start_time": lap_start,
                "total_elapsed_time": dur,
                "total_timer_time": dur,
                "total_distance": lap_km * 1000,
                "enhanced_avg_speed": speed,
                "avg_heart_rate": 130 + 10 * i,
                "max_heart_rate": 140 + 10 * i,
                "sport": "running",
            },
        )
    end = start + timedelta(seconds=seconds)
    enc.on_mesg(MESG["event"], {"timestamp": end, "event": "timer", "event_type": "stop_all"})
    enc.on_mesg(
        MESG["session"],
        {
            "message_index": 0,
            "timestamp": end,
            "start_time": start,
            "total_elapsed_time": float(seconds),
            "total_timer_time": float(seconds),
            "total_distance": km * 1000,
            "sport": "running",
            "sub_sport": sub_sport,
            "avg_heart_rate": 140,
            "max_heart_rate": 160,
            "total_calories": 210,
            "enhanced_avg_speed": speed,
            "total_ascent": 12,
            "avg_running_cadence": 83,
            "avg_fractional_cadence": 0.0,
            "total_training_effect": 2.8,
            "total_anaerobic_training_effect": 0.3,
            "time_in_hr_zone": [30.0, 300.0, 450.0, 120.0, 0.0],
            "first_lap_index": 0,
            "num_laps": laps,
        },
    )
    enc.on_mesg(
        MESG["activity"],
        {
            "timestamp": end,
            "total_timer_time": float(seconds),
            "num_sessions": 1,
            "type": "manual",
            "event": "activity",
            "event_type": "stop",
            "local_timestamp": int((end - datetime(1989, 12, 31, tzinfo=UTC)).total_seconds()) + 3600,
        },
    )
    return enc.close()


def strength_fit(start: datetime = datetime(2026, 11, 19, 17, 0, 0, tzinfo=UTC), *, with_sets: bool = True) -> bytes:
    """Seduta di forza: 2 serie attive (panca 10 x 60 kg, squat 8 x 80 kg) e un recupero; FC senza GPS."""
    enc = Encoder()
    enc.on_mesg(MESG["file_id"], {"type": "activity", "manufacturer": "development", "product": 1, "time_created": start, "serial_number": 4242})
    total = 600
    for s in range(0, total + 1, 5):
        enc.on_mesg(MESG["record"], {"timestamp": start + timedelta(seconds=s), "heart_rate": 95 + (s // 20) % 30})
    sets = [
        {"start": 0, "duration": 40.0, "type": "active", "reps": 10, "weight": 60.0, "cat": "bench_press", "sub": 1},
        {"start": 40, "duration": 120.0, "type": "rest"},
        {"start": 160, "duration": 45.0, "type": "active", "reps": 8, "weight": 80.0, "cat": "squat", "sub": 6},
    ]
    for i, s in enumerate(sets if with_sets else []):
        mesg = {
            "message_index": i,
            "timestamp": start + timedelta(seconds=s["start"] + s["duration"]),
            "start_time": start + timedelta(seconds=s["start"]),
            "duration": s["duration"],
            "set_type": s["type"],
        }
        if s["type"] == "active":
            mesg.update({"repetitions": s["reps"], "weight": s["weight"], "category": [s["cat"]], "category_subtype": [s["sub"]]})
        enc.on_mesg(MESG["set"], mesg)
    end = start + timedelta(seconds=total)
    enc.on_mesg(MESG["lap"], {"message_index": 0, "timestamp": end, "start_time": start, "total_elapsed_time": float(total), "total_timer_time": float(total)})
    enc.on_mesg(
        MESG["session"],
        {
            "message_index": 0,
            "timestamp": end,
            "start_time": start,
            "total_elapsed_time": float(total),
            "total_timer_time": float(total),
            "sport": "training",
            "sub_sport": "strength_training",
            "avg_heart_rate": 110,
            "max_heart_rate": 140,
            "total_calories": 150,
            "first_lap_index": 0,
            "num_laps": 1,
        },
    )
    return enc.close()


def zipped(fit: bytes, name: str = "123_ACTIVITY.fit") -> bytes:
    """Come lo restituisce /download-service/files/activity/{id}: uno ZIP con il file originale."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(name, fit)
    return buf.getvalue()


SQUAT_NAME = Profile["types"]["squat_exercise_name"][6]
BENCH_NAME = Profile["types"]["bench_press_exercise_name"][1]
