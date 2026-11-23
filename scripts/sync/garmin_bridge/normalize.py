"""Normalizzazione delle risposte della Garmin Connect Personal API nel contratto SyncBundle.

I nomi dei campi Garmin vengono dagli schemi DTO dello swagger ufficiale
(SummarizedActivityDTO, UserDailySummaryV2DTO, DailySleepDTO, HrvSummaryDTO, MaxMetDTO,
FitnessAgeDTO, WeightRangeDTO, ActivityWorkoutDTO...). Regole del contratto (src/db/types.ts):
- date locali 'YYYY-MM-DD', istanti ISO 8601 con offset;
- unita' metriche; un dato che manca e' ASSENTE (mai 0 o None di ripiego);
- nessun dato di posizione o personale oltre a quelli previsti (niente coordinate di partenza,
  luoghi, nomi utente).
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping
from datetime import UTC, datetime, timedelta, tzinfo
from typing import Any

# ------------------------------------------------------------------ tipi di attivita'

RUN_KEYS = {
    "running",
    "trail_running",
    "treadmill_running",
    "track_running",
    "indoor_running",
    "street_running",
    "ultra_run",
    "virtual_run",
    "obstacle_run",
}
WALK_KEYS = {"walking", "hiking", "casual_walking", "speed_walking", "indoor_walking"}
BIKE_KEYS = {"virtual_ride", "bmx", "cyclocross"}
DEFAULT_NAMES = {
    "corsa": "Corsa",
    "forza": "Forza",
    "camminata": "Camminata",
    "bici": "Bici",
    "nuoto": "Nuoto",
    "altro": "Attività",
}

# Campi del WellnessDay prodotti da ciascuna fonte (servono per l'unione incrementale).
SUMMARY_FIELDS = (
    "steps",
    "activeKcal",
    "totalKcal",
    "restingHr",
    "stressAvg",
    "bodyBatteryHigh",
    "bodyBatteryLow",
    "bodyBatteryCharged",
    "bodyBatteryDrained",
    "hydrationMl",
    "respirationAvg",
    "spo2Avg",
)
SLEEP_FIELDS = ("sleepSec", "sleepScore", "deepSec", "lightSec", "remSec", "awakeSec", "sleepStart", "sleepEnd")
HRV_FIELDS = ("hrvNightAvg", "hrvWeeklyAvg", "hrvBaselineLow", "hrvBaselineHigh", "hrvStatus")
VO2_FIELDS = ("vo2max",)
FITNESS_AGE_FIELDS = ("fitnessAge",)
STEPS_FALLBACK_FIELDS = ("steps",)
STRESS_FALLBACK_FIELDS = ("stressAvg",)
BODY_BATTERY_FALLBACK_FIELDS = ("bodyBatteryHigh", "bodyBatteryLow", "bodyBatteryCharged", "bodyBatteryDrained")
HYDRATION_FALLBACK_FIELDS = ("hydrationMl",)


def kind_from_type_key(type_key: str | None) -> str:
    """Chiave Garmin del tipo (es. 'trail_running') -> ActivityKind dell'app."""
    k = (type_key or "").strip().lower()
    if k in RUN_KEYS:
        return "corsa"
    if k == "strength_training":
        return "forza"
    if k in WALK_KEYS:
        return "camminata"
    if "cycling" in k or "biking" in k or k in BIKE_KEYS or k.startswith("e_bike"):
        return "bici"
    if "swim" in k:
        return "nuoto"
    return "altro"


# ------------------------------------------------------------------ numeri e pulizia


def num(value: Any) -> float | None:
    """Numero finito oppure None (rifiuta bool, stringhe vuote, NaN)."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            f = float(value)
        except ValueError:
            return None
        return f if math.isfinite(f) else None
    return None


def as_int(value: Any, *, positive: bool = False, non_negative: bool = False) -> int | None:
    f = num(value)
    if f is None:
        return None
    if positive and f <= 0:
        return None
    if non_negative and f < 0:
        return None
    return int(round(f))


def as_round(value: Any, digits: int = 1, *, positive: bool = False) -> float | None:
    f = num(value)
    if f is None or (positive and f <= 0):
        return None
    return round(f, digits)


def clean(d: Mapping[str, Any]) -> dict[str, Any]:
    """Toglie le chiavi con valore None."""
    return {k: v for k, v in d.items() if v is not None}


def _get(obj: Any, *path: str) -> Any:
    for key in path:
        if not isinstance(obj, Mapping):
            return None
        obj = obj.get(key)
    return obj


def _list(resp: Any, *keys: str) -> list[Any]:
    """La lista utile di una risposta: la risposta stessa o un campo contenitore."""
    if isinstance(resp, list):
        return resp
    for key in keys:
        value = _get(resp, key)
        if isinstance(value, list):
            return value
    return []


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def as_date(value: Any) -> str | None:
    if isinstance(value, str):
        v = value.strip()[:10]
        if DATE_RE.match(v):
            return v
    if isinstance(value, Mapping):  # ConnectDate {date, localDate}
        return as_date(value.get("localDate"))
    return None


# ------------------------------------------------------------------ orari


def parse_ts(value: Any) -> datetime | None:
    """Istante Garmin -> datetime naive (orario di parete, nessun fuso).

    Accetta millisecondi dall'epoca, 'yyyy-MM-dd HH:mm:ss', ISO con o senza frazioni, 'Z' o offset
    (in quel caso converte in UTC).
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value <= 0:
            return None
        return datetime.fromtimestamp(value / 1000.0, UTC).replace(tzinfo=None)
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip().replace(" ", "T", 1)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # frazioni di secondo di lunghezza qualsiasi: fromisoformat vuole 3 o 6 cifre fino a 3.10
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(.*)$", s)
    if not m:
        return None
    base, frac, rest = m.group(1), m.group(2) or "", m.group(3) or ""
    if frac:
        frac = (frac + "000000")[:7]
    try:
        dt = datetime.fromisoformat(base + frac + rest)
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def format_offset(minutes: int) -> str:
    sign = "+" if minutes >= 0 else "-"
    minutes = abs(minutes)
    return f"{sign}{minutes // 60:02d}:{minutes % 60:02d}"


def iso_from_pair(local: Any, gmt: Any, fallback_tz: tzinfo | None = None) -> str | None:
    """Ora locale + ora GMT -> ISO 8601 con offset (es. '2026-11-18T07:30:05+01:00')."""
    loc = parse_ts(local)
    utc = parse_ts(gmt)
    if loc is not None and utc is not None:
        offset = round((loc - utc).total_seconds() / 900.0) * 15
        if abs(offset) <= 14 * 60:
            return loc.replace(microsecond=0).isoformat() + format_offset(offset)
    if utc is not None:
        if fallback_tz is not None:
            aware = utc.replace(tzinfo=UTC).astimezone(fallback_tz)
            return aware.replace(microsecond=0).isoformat()
        return utc.replace(microsecond=0).isoformat() + "Z"
    if loc is not None and fallback_tz is not None:
        aware = loc.replace(tzinfo=fallback_tz)
        return aware.replace(microsecond=0).isoformat()
    return None


def local_date_of(iso: str) -> str:
    """Data locale di un istante ISO con offset: sono i primi 10 caratteri."""
    return iso[:10]


# ------------------------------------------------------------------ attivita'


def activity_from_summary(dto: Mapping[str, Any], fallback_tz: tzinfo | None = None) -> dict[str, Any] | None:
    """SummarizedActivityDTO (lista attivita') -> Activity senza dettagli FIT."""
    aid = as_int(dto.get("activityId"), positive=True)
    if aid is None:
        return None
    start = iso_from_pair(dto.get("startTimeLocal"), dto.get("startTimeGMT"), fallback_tz)
    if start is None:
        start = iso_from_pair(None, dto.get("beginTimestamp"), fallback_tz)
    if start is None:
        return None
    type_key = _get(dto, "activityType", "typeKey")
    type_key = type_key.strip() if isinstance(type_key, str) and type_key.strip() else "other"
    kind = kind_from_type_key(type_key)
    name = dto.get("activityName")
    name = name.strip() if isinstance(name, str) and name.strip() else DEFAULT_NAMES[kind]

    duration = num(dto.get("duration"))
    if duration is None:
        duration = num(dto.get("elapsedDuration")) or 0.0
    distance = as_int(dto.get("distance"), positive=True)
    speed = num(dto.get("averageSpeed"))
    pace = None
    if distance and speed and speed > 0 and kind != "forza":
        pace = int(round(1000.0 / speed))
    cadence = as_int(dto.get("averageRunningCadenceInStepsPerMinute"), positive=True)
    if cadence is None:
        cadence = as_int(dto.get("averageBikingCadenceInRevPerMinute"), positive=True)

    zones = [num(dto.get(f"hrTimeInZone_{i}")) for i in range(1, 6)]
    hr_zones = [int(round(z or 0)) for z in zones] if any(z is not None for z in zones) else None

    return clean(
        {
            "id": f"garmin:{aid}",
            "source": "garmin",
            "kind": kind,
            "typeKey": type_key,
            "name": name,
            "start": start,
            "durationSec": int(round(max(duration, 0.0))),
            "movingSec": as_int(dto.get("movingDuration"), positive=True),
            "distanceM": distance,
            "avgHr": as_int(dto.get("averageHR"), positive=True),
            "maxHr": as_int(dto.get("maxHR"), positive=True),
            "calories": as_int(dto.get("calories"), positive=True),
            "elevGainM": as_int(dto.get("elevationGain"), non_negative=True),
            "avgPaceSecPerKm": pace,
            "avgCadence": cadence,
            "aerobicTE": as_round(dto.get("aerobicTrainingEffect"), 1, positive=True),
            "anaerobicTE": as_round(dto.get("anaerobicTrainingEffect"), 1, positive=True),
            "trainingLoad": as_round(dto.get("activityTrainingLoad"), 1, positive=True),
            "hrZonesSec": hr_zones,
        }
    )


def garmin_activity_id(activity_id: str) -> str | None:
    """'garmin:123' -> '123' (solo cifre), altrimenti None."""
    if activity_id.startswith("garmin:"):
        tail = activity_id[len("garmin:") :]
        if tail.isascii() and tail.isdecimal():
            return tail
    return None


# ------------------------------------------------------------------ esercizi di forza

_CAMEL_RE = re.compile(r"(?<=[a-z])(?=[A-Z0-9])|(?<=[0-9])(?=[A-Za-z])|(?<=[A-Z])(?=[A-Z][a-z])")


def exercise_key(name: str | None) -> str | None:
    """Nome Garmin in qualsiasi forma ('bench_press', 'benchPress', 'BENCH_PRESS') -> 'BENCH_PRESS'."""
    if not isinstance(name, str) or not name.strip():
        return None
    s = name.strip()
    if "_" not in s and " " not in s and not s.isupper():
        s = _CAMEL_RE.sub("_", s)
    s = re.sub(r"[\s\-]+", "_", s).upper()
    return s or None


def humanize_key(key: str | None) -> str | None:
    """'BARBELL_BENCH_PRESS' -> 'Barbell bench press' (reversibile: maiuscolo e '_' tornano la chiave)."""
    if not key:
        return None
    words = key.replace("_", " ").strip().lower()
    return words[:1].upper() + words[1:] if words else None


def exercise_set(category_key: str | None, name_key: str | None, *, reps: Any = None, kg: Any = None, duration: Any = None) -> dict[str, Any]:
    category = category_key if category_key and category_key != "UNKNOWN" else None
    name = humanize_key(name_key) or humanize_key(category) or "Esercizio"
    return clean(
        {
            "name": name,
            "category": category,
            "reps": as_int(reps, positive=True),
            "kg": as_round(kg, 2, positive=True),
            "durationSec": as_int(duration, positive=True),
        }
    )


def exercise_sets_from_workouts(resp: Any) -> list[dict[str, Any]]:
    """ActivityWorkoutDTO[] -> serie di forza (passi ACTIVE con esercizio). Ripiego se il FIT non ha 'set'."""
    out: list[dict[str, Any]] = []
    for workout in _list(resp):
        for step in _list(_get(workout, "steps")):
            if not isinstance(step, Mapping):
                continue
            intensity = str(step.get("intensity") or "ACTIVE").upper()
            if intensity in {"REST", "RECOVERY", "WARMUP", "COOLDOWN"}:
                continue
            category = exercise_key(step.get("exerciseCategory"))
            name = exercise_key(step.get("exerciseName"))
            if not category and not name:
                continue
            dtype = str(step.get("durationType") or "").upper()
            reps = step.get("durationValue") if dtype == "REPS" else None
            duration = step.get("durationValue") if dtype == "TIME" else None
            out.append(exercise_set(category, name, reps=reps, kg=step.get("exerciseWeightValue"), duration=duration))
    return out


# ------------------------------------------------------------------ benessere


def wellness_from_daily_summaries(resp: Any) -> dict[str, dict[str, Any]]:
    """UserDailySummaryV2DTO (risposta {data: [...]}) -> campi del giorno."""
    out: dict[str, dict[str, Any]] = {}
    for item in _list(resp, "data"):
        if not isinstance(item, Mapping):
            continue
        day = as_date(item.get("calendarDate"))
        if not day:
            continue
        has_wellness = item.get("includesWellnessData") is not False
        stress = as_int(_get(item, "stress", "avgLevel"), positive=True)
        fields = {
            "steps": as_int(_get(item, "movement", "steps", "value"), non_negative=True) if has_wellness else None,
            "activeKcal": as_int(_get(item, "calories", "burnedActive"), non_negative=True),
            "totalKcal": as_int(_get(item, "calories", "burnedTotal"), positive=True),
            "restingHr": as_int(_get(item, "heartRate", "restingValue"), positive=True),
            "stressAvg": stress,
            "bodyBatteryHigh": as_int(_get(item, "bodyBattery", "maxValue"), non_negative=True),
            "bodyBatteryLow": as_int(_get(item, "bodyBattery", "minValue"), non_negative=True),
            "bodyBatteryCharged": as_int(_get(item, "bodyBattery", "chargedValue"), non_negative=True),
            "bodyBatteryDrained": as_int(_get(item, "bodyBattery", "drainedValue"), non_negative=True),
            "hydrationMl": as_int(_get(item, "hydration", "consumedInFractionalMl"), positive=True),
            "respirationAvg": as_round(_get(item, "respiration", "avgValue"), 1, positive=True),
            "spo2Avg": as_round(_get(item, "pulseOx", "avgValue"), 1, positive=True),
        }
        if not has_wellness:
            fields["activeKcal"] = None
            fields["totalKcal"] = None
        cleaned = clean(fields)
        if cleaned:
            out[day] = cleaned
    return out


def wellness_from_sleep(resp: Any, fallback_tz: tzinfo | None = None) -> dict[str, dict[str, Any]]:
    """DailySleepDTO[] -> sonno del giorno (Garmin assegna la notte al giorno del risveglio)."""
    out: dict[str, dict[str, Any]] = {}
    for item in _list(resp, "dailySleepDTO"):
        if not isinstance(item, Mapping):
            continue
        day = as_date(item.get("calendarDate"))
        total = as_int(item.get("sleepTimeSeconds"), positive=True)
        if not day or total is None:
            continue
        fields = {
            "sleepSec": total,
            "sleepScore": as_int(_get(item, "sleepScores", "overall", "value"), positive=True),
            "deepSec": as_int(item.get("deepSleepSeconds"), non_negative=True),
            "lightSec": as_int(item.get("lightSleepSeconds"), non_negative=True),
            "remSec": as_int(item.get("remSleepSeconds"), non_negative=True),
            "awakeSec": as_int(item.get("awakeSleepSeconds"), non_negative=True),
            "sleepStart": iso_from_pair(
                item.get("sleepStartTimestampLocal"), item.get("sleepStartTimestampGMT"), fallback_tz
            ),
            "sleepEnd": iso_from_pair(item.get("sleepEndTimestampLocal"), item.get("sleepEndTimestampGMT"), fallback_tz),
        }
        out[day] = clean(fields)
    return out


def wellness_from_hrv(resp: Any) -> dict[str, dict[str, Any]]:
    """HrvDailySummaryDTO {hrvSummaries: [...]} -> HRV della notte, media 7 giorni, intervallo normale, stato."""
    out: dict[str, dict[str, Any]] = {}
    for item in _list(resp, "hrvSummaries"):
        if not isinstance(item, Mapping):
            continue
        day = as_date(item.get("calendarDate"))
        if not day:
            continue
        status = item.get("status")
        status = status.strip().upper() if isinstance(status, str) and status.strip() else None
        if status in {"NONE", "INVALID"}:
            status = None
        fields = clean(
            {
                "hrvNightAvg": as_int(item.get("lastNightAvg"), positive=True),
                "hrvWeeklyAvg": as_int(item.get("weeklyAvg"), positive=True),
                "hrvBaselineLow": as_int(_get(item, "baseline", "balancedLow"), positive=True),
                "hrvBaselineHigh": as_int(_get(item, "baseline", "balancedUpper"), positive=True),
                "hrvStatus": status,
            }
        )
        if fields:
            out[day] = fields
    return out


def wellness_from_vo2max(resp: Any) -> dict[str, dict[str, Any]]:
    """MaxMetDTO[] -> VO2max generico (corsa) del giorno."""
    out: dict[str, dict[str, Any]] = {}
    for item in _list(resp):
        generic = _get(item, "generic")
        if not isinstance(generic, Mapping):
            continue
        day = as_date(generic.get("calendarDate"))
        value = as_round(generic.get("vo2MaxPreciseValue"), 1, positive=True)
        if value is None:
            value = as_round(generic.get("vo2MaxValue"), 1, positive=True)
        if day and value is not None:
            out[day] = {"vo2max": value}
    return out


def fitness_age_from(resp: Any) -> float | None:
    """FitnessAgeDTO[] -> eta' fitness piu' recente (None se Garmin non la calcola)."""
    for item in _list(resp):
        value = as_round(_get(item, "fitnessAge"), 1, positive=True)
        if value is not None:
            return value
    return None


def wellness_from_steps_stats(resp: Any) -> dict[str, dict[str, Any]]:
    out = {}
    for item in _list(resp):
        day = as_date(_get(item, "calendarDate"))
        steps = as_int(_get(item, "totalSteps"), non_negative=True)
        if day and steps is not None:
            out[day] = {"steps": steps}
    return out


def wellness_from_stress_stats(resp: Any) -> dict[str, dict[str, Any]]:
    out = {}
    for item in _list(resp):
        day = as_date(_get(item, "calendarDate"))
        stress = as_int(_get(item, "values", "overallStressLevel"), positive=True)
        if day and stress is not None:
            out[day] = {"stressAvg": stress}
    return out


def wellness_from_body_battery(resp: Any) -> dict[str, dict[str, Any]]:
    """BodyBatteryDailyReportDTO[] -> massimo/minimo (dalla colonna bodyBatteryLevel), caricato, scaricato."""
    out = {}
    for item in _list(resp):
        if not isinstance(item, Mapping):
            continue
        day = as_date(item.get("date"))
        if not day:
            continue
        level_idx = None
        for desc in _list(item.get("bodyBatteryValueDescriptorDTOList")):
            if _get(desc, "bodyBatteryValueDescriptorKey") == "bodyBatteryLevel":
                level_idx = as_int(_get(desc, "bodyBatteryValueDescriptorIndex"), non_negative=True)
        levels: list[int] = []
        if level_idx is not None:
            for row in _list(item.get("bodyBatteryValuesArray")):
                if isinstance(row, list) and len(row) > level_idx:
                    v = as_int(row[level_idx], non_negative=True)
                    if v is not None:
                        levels.append(v)
        fields = clean(
            {
                "bodyBatteryHigh": max(levels) if levels else None,
                "bodyBatteryLow": min(levels) if levels else None,
                "bodyBatteryCharged": as_int(item.get("charged"), non_negative=True),
                "bodyBatteryDrained": as_int(item.get("drained"), non_negative=True),
            }
        )
        if fields:
            out[day] = fields
    return out


def wellness_from_hydration_stats(resp: Any) -> dict[str, dict[str, Any]]:
    out = {}
    for item in _list(resp):
        day = as_date(_get(item, "calendarDate"))
        ml = as_int(_get(item, "valueInML"), positive=True)
        if day and ml is not None:
            out[day] = {"hydrationMl": ml}
    return out


# ------------------------------------------------------------------ peso


def _kg(value: Any) -> float | None:
    w = num(value)
    if w is None or w <= 0:
        return None
    if w > 1000:  # alcune risposte Garmin storiche esprimono il peso in grammi
        w = w / 1000.0
    return round(w, 2) if 20 <= w <= 400 else None


def weights_from_range(resp: Any) -> dict[str, dict[str, Any]]:
    """WeightRangeDTO -> WeightEntry per data (l'ultima pesata del giorno)."""
    out: dict[str, dict[str, Any]] = {}
    for item in _list(resp, "dailyWeightSummaries"):
        if not isinstance(item, Mapping):
            continue
        latest = item.get("latestWeight")
        if not isinstance(latest, Mapping):
            continue
        day = as_date(item.get("summaryDate")) or as_date(latest.get("calendarDate"))
        kg = _kg(latest.get("weight"))
        if not day or kg is None:
            continue
        fat = as_round(latest.get("bodyFat"), 1, positive=True)
        out[day] = clean({"date": day, "kg": kg, "source": "garmin", "bodyFatPct": fat if fat and fat < 75 else None})
    return out


def has_previous_weight(resp: Any) -> bool:
    """Il WeightRangeDTO indica una pesata precedente all'intervallo (serve per fermare lo storico)."""
    prev = _get(resp, "previousDateWeight")
    return isinstance(prev, Mapping) and _kg(prev.get("weight")) is not None


# ------------------------------------------------------------------ utilita' sulle date


def date_range_chunks(start: str, end: str, max_days: int) -> Iterable[tuple[str, str]]:
    """Intervalli [a, b] inclusivi di al massimo max_days giorni, dal piu' vecchio al piu' recente."""
    d = datetime.strptime(start, "%Y-%m-%d").date()
    last = datetime.strptime(end, "%Y-%m-%d").date()
    while d <= last:
        b = min(last, d + timedelta(days=max_days - 1))
        yield d.isoformat(), b.isoformat()
        d = b + timedelta(days=1)
