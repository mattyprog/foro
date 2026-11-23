"""Server Garmin FINTO per i test: risponde come la Personal API (forme dello swagger) con dati SINTETICI.

Si inserisce al posto di requests.Session nel client Python ufficiale (PersonalApiAuthenticator e
GarminPersonalApiClient accettano `session=`), cosi' i test esercitano anche il codice di Garmin.
"""

from __future__ import annotations

import base64
import json
import re
import time
from datetime import UTC, date, datetime, timedelta
from datetime import time as dtime
from typing import Any
from urllib.parse import urlsplit

import helpers  # noqa: F401
from synthetic_fit import START_LAT, START_LON, run_fit, strength_fit, zipped

TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
FAKE_API_KEY = "chiave-finta-solo-test"


def fake_jwt(n: int) -> str:
    def b64(obj: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")

    return f"{b64({'alg': 'none'})}.{b64({'exp': int(time.time()) + 86400, 'n': n})}.firma"


class FakeResponse:
    def __init__(self, status: int, body: Any = None, *, raw: bytes | None = None):
        self.status_code = status
        if raw is not None:
            self.content = raw
        elif body is None:
            self.content = b""
        else:
            self.content = json.dumps(body).encode("utf-8")
        self.text = self.content.decode("utf-8", "replace")
        self.ok = 200 <= status < 300
        self.headers: dict[str, str] = {}

    def json(self) -> Any:
        return json.loads(self.content)


def _d(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


class FakeGarmin:
    """Account sintetico + router delle richieste. `calls` registra (metodo, path, params)."""

    def __init__(self, today: date = date(2026, 11, 20)):
        self.today = today
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.fail: dict[str, int] = {}  # prefisso di path -> stato HTTP restituito sempre
        self.fail_once: dict[str, list[int]] = {}  # prefisso -> stati da restituire prima di rispondere bene
        self.token_status = 200
        self.tokens_issued = 0
        self.valid_tokens: set[str] = set()
        self._build_account()

    # ------------------------------------------------------------ dati sintetici

    def _local_and_gmt(self, days_ago: int, hour: int) -> tuple[datetime, datetime]:
        local = datetime.combine(self.today - timedelta(days=days_ago), dtime(hour, 0, 5))
        return local, local - timedelta(hours=1)  # fuso sintetico fisso +01:00

    def _activity(self, aid: int, days_ago: int, hour: int, type_key: str, name: str, duration: float, distance: float | None):
        local, gmt = self._local_and_gmt(days_ago, hour)
        dto = {
            "activityId": aid,
            "activityName": name,
            "startTimeLocal": local.strftime("%Y-%m-%d %H:%M:%S"),
            "startTimeGMT": gmt.strftime("%Y-%m-%d %H:%M:%S"),
            "activityType": {"typeId": 1, "typeKey": type_key, "parentTypeId": 17},
            "duration": duration,
            "elapsedDuration": duration + 20,
            "movingDuration": duration - 5,
            "averageHR": 138.0,
            "maxHR": 166.0,
            "calories": 320.0,
            "aerobicTrainingEffect": 2.6,
            "activityTrainingLoad": 55.0,
            "hrTimeInZone_1": 60.0,
            "hrTimeInZone_2": duration - 160,
            "hrTimeInZone_3": 100.0,
            # campi che NON devono finire nel pacchetto
            "startLatitude": START_LAT,
            "startLongitude": START_LON,
            "locationName": "Olathe",
            "ownerFullName": "Utente Sintetico",
        }
        if distance:
            dto.update({"distance": distance, "averageSpeed": distance / duration, "elevationGain": 12.0})
        return dto, gmt.replace(tzinfo=UTC)

    def _build_account(self) -> None:
        self.activities: dict[int, dict[str, Any]] = {}
        self.fit_files: dict[int, bytes] = {}
        specs = [
            # id, giorni fa, ora, tipo, nome, durata, distanza, fit
            (9000000101, 2, 7, "running", "Corsa facile sintetica", 900.0, 3000.0, "run"),
            (9000000102, 1, 18, "strength_training", "Forza A sintetica", 600.0, None, "strength"),
            (9000000103, 10, 19, "treadmill_running", "Tapis roulant sintetico, più lento", 900.0, 3000.0, "treadmill"),
            (9000000108, 5, 18, "strength_training", "Forza B sintetica", 600.0, None, "strength_nosets"),
            (9000000104, 30, 12, "walking", "Camminata sintetica", 1800.0, 2400.0, None),
            (9000000105, 120, 9, "road_biking", "Bici sintetica", 3600.0, 25000.0, "run"),
            (9000000106, 200, 8, "running", "Corsa vecchia sintetica", 1500.0, 5000.0, None),
            (9000000107, 400, 8, "running", "Corsa fuori finestra", 1500.0, 5000.0, None),
        ]
        for aid, ago, hour, type_key, name, duration, distance, fit in specs:
            dto, start_utc = self._activity(aid, ago, hour, type_key, name, duration, distance)
            self.activities[aid] = dto
            if fit == "run":
                self.fit_files[aid] = zipped(run_fit(start_utc))
            elif fit == "treadmill":
                self.fit_files[aid] = zipped(run_fit(start_utc, gps=False, sub_sport="treadmill"))
            elif fit == "strength":
                self.fit_files[aid] = zipped(strength_fit(start_utc))
            elif fit == "strength_nosets":
                self.fit_files[aid] = zipped(strength_fit(start_utc, with_sets=False))
        self.workouts = {
            9000000108: [
                {
                    "workoutName": "Forza B",
                    "steps": [
                        {"stepIndex": 0, "intensity": "ACTIVE", "durationType": "REPS", "durationValue": 12,
                         "exerciseCategory": "ROW", "exerciseName": "SEATED_CABLE_ROW", "exerciseWeightValue": 40.0},
                        {"stepIndex": 1, "intensity": "REST", "durationType": "TIME", "durationValue": 90},
                    ],
                }
            ]
        }
        # benessere: valori deterministici per ogni giorno degli ultimi 2 anni
        self.days: dict[str, dict[str, Any]] = {}
        for i in range(0, 730):
            day = (self.today - timedelta(days=i)).isoformat()
            self.days[day] = {
                "steps": 6000 + (i * 137) % 5000,
                "resting": 52 + i % 5,
                "stress": 25 + i % 10,
                "bb": (80 - i % 15, 15 + i % 10, 50 + i % 20, 55 + i % 20),
                "kcal": (400 + i % 300, 2300 + i % 300),
                "hydration": 1200 if i % 2 == 0 else 0,
                "sleep": 25200 + (i % 7) * 300,
                "hrv": 55 + i % 10,
                "vo2": 46.5 + (i % 3) / 10 if i % 3 == 0 else None,
            }
        self.weights: dict[str, float] = {}
        for k in range(0, 105):
            day = (self.today - timedelta(days=7 * k)).isoformat()
            self.weights[day] = round(72.0 + 0.02 * k, 2)

    # ------------------------------------------------------------ interfaccia requests.Session

    def close(self) -> None:
        pass

    def post(self, url: str, headers: dict[str, str] | None = None, timeout: float | None = None, **_: Any) -> FakeResponse:
        path = urlsplit(url).path
        self.calls.append(("POST", path, {}))
        if path != TOKEN_PATH:
            return FakeResponse(404)
        if self.token_status != 200:
            return FakeResponse(self.token_status, {"message": "no"})
        if (headers or {}).get("Authorization") != f"ApiKey {FAKE_API_KEY}":
            return FakeResponse(401, {"message": "chiave non valida"})
        self.tokens_issued += 1
        token = fake_jwt(self.tokens_issued)
        self.valid_tokens.add(token)
        return FakeResponse(200, raw=token.encode())

    def expire_tokens(self) -> None:
        self.valid_tokens.clear()

    def get(self, url: str, headers: dict[str, str] | None = None, params: dict[str, Any] | None = None, timeout: float | None = None, **_: Any) -> FakeResponse:
        parts = urlsplit(url)
        path = parts.path
        params = dict(params or {})
        self.calls.append(("GET", path, params))
        auth = (headers or {}).get("Authorization", "")
        if not auth.startswith("Bearer ") or auth[len("Bearer ") :] not in self.valid_tokens:
            return FakeResponse(401, {"message": "token scaduto"})
        for prefix, statuses in list(self.fail_once.items()):
            if path.startswith(prefix) and statuses:
                return FakeResponse(statuses.pop(0), {"message": "errore temporaneo"})
        for prefix, status in self.fail.items():
            if path.startswith(prefix):
                return FakeResponse(status, {"message": "errore"})
        return self._route(path, params)

    def calls_to(self, prefix: str) -> list[tuple[str, str, dict[str, Any]]]:
        return [c for c in self.calls if c[1].startswith(prefix)]

    # ------------------------------------------------------------ router

    def _route(self, path: str, params: dict[str, Any]) -> FakeResponse:
        m = re.fullmatch(r"/download-service/files/activity/(\d+)", path)
        if m:
            aid = int(m.group(1))
            if aid in self.fit_files and aid in self.activities:
                return FakeResponse(200, raw=self.fit_files[aid])
            return FakeResponse(404)
        m = re.fullmatch(r"/activity-service/activity/(\d+)/workouts", path)
        if m:
            return FakeResponse(200, self.workouts.get(int(m.group(1)), []))
        if path == "/activitylist-service/activities/search/activities":
            return self._search(params)
        if path == "/usersummary-service/v2/dailysummaries":
            return self._ranged(params["startDate"], params["endDate"], 366, self._summary_v2, wrap="data")
        if path == "/sleep-service/sleep/dailySleepSummariesByDate":
            return self._ranged(params["startDate"], params["endDate"], 31, self._sleep)
        m = re.fullmatch(r"/hrv-service/hrv/daily/([\d-]+)/([\d-]+)", path)
        if m:
            return self._ranged(m.group(1), m.group(2), 31, self._hrv, wrap="hrvSummaries")
        m = re.fullmatch(r"/metrics-service/metrics/maxmet/daily/([\d-]+)/([\d-]+)", path)
        if m:
            return self._ranged(m.group(1), m.group(2), 31, self._vo2)
        m = re.fullmatch(r"/fitnessage-service/fitnessage/v2/([\d-]+)", path)
        if m:
            return FakeResponse(200, [{"chronologicalAge": 30, "fitnessAge": 27.43, "lastUpdated": "2026-11-01T00:00:00"}])
        m = re.fullmatch(r"/weight-service/weight/range/([\d-]+)/([\d-]+)", path)
        if m:
            return self._weights(m.group(1), m.group(2))
        m = re.fullmatch(r"/usersummary-service/stats/steps/daily/([\d-]+)/([\d-]+)", path)
        if m:
            return self._ranged(m.group(1), m.group(2), 28, lambda d, v: {"calendarDate": d, "totalSteps": v["steps"]})
        m = re.fullmatch(r"/usersummary-service/stats/stress/daily/([\d-]+)/([\d-]+)", path)
        if m:
            return self._ranged(m.group(1), m.group(2), 28, lambda d, v: {"calendarDate": d, "values": {"overallStressLevel": v["stress"]}})
        m = re.fullmatch(r"/usersummary-service/stats/hydration/daily/([\d-]+)/([\d-]+)", path)
        if m:
            return self._ranged(m.group(1), m.group(2), 31, lambda d, v: {"calendarDate": d, "valueInML": float(v["hydration"])})
        if path == "/wellness-service/wellness/bodyBattery/reports/daily":
            return self._ranged(params["startDate"], params["endDate"], 31, self._body_battery)
        return FakeResponse(404)

    def _search(self, params: dict[str, Any]) -> FakeResponse:
        start, limit = int(params.get("start", 0)), int(params.get("limit", 20))
        a, b = params.get("startDate"), params.get("endDate")
        items = []
        for dto in self.activities.values():
            day = dto["startTimeLocal"][:10]
            if (a is None or day >= a) and (b is None or day <= b):
                items.append(dto)
        items.sort(key=lambda x: x["startTimeLocal"], reverse=True)
        return FakeResponse(200, items[start : start + limit])

    def _ranged(self, a: str, b: str, max_days: int, fn, wrap: str | None = None) -> FakeResponse:
        da, db = _d(a), _d(b)
        if (db - da).days + 1 > max_days or db < da:
            return FakeResponse(400, {"message": "intervallo troppo lungo"})
        out = []
        d = da
        while d <= db:
            v = self.days.get(d.isoformat())
            if v is not None:
                item = fn(d.isoformat(), v)
                if item is not None:
                    out.append(item)
            d += timedelta(days=1)
        return FakeResponse(200, {wrap: out} if wrap else out)

    @staticmethod
    def _summary_v2(day: str, v: dict[str, Any]) -> dict[str, Any]:
        high, low, charged, drained = v["bb"]
        return {
            "calendarDate": day,
            "includesWellnessData": True,
            "movement": {"steps": {"goal": 8000, "value": v["steps"]}},
            "calories": {"burnedActive": v["kcal"][0], "burnedTotal": v["kcal"][1]},
            "heartRate": {"restingValue": v["resting"], "minValue": v["resting"] - 3, "maxValue": 170},
            "stress": {"avgLevel": v["stress"], "maxLevel": 90},
            "bodyBattery": {"maxValue": high, "minValue": low, "chargedValue": charged, "drainedValue": drained},
            "hydration": {"consumedInFractionalMl": float(v["hydration"])},
            "respiration": {"avgValue": 14},
            "pulseOx": {"avgValue": 96},
        }

    @staticmethod
    def _sleep(day: str, v: dict[str, Any]) -> dict[str, Any]:
        end_local = datetime.combine(_d(day), dtime(6, 50))
        start_local = end_local - timedelta(seconds=v["sleep"] + 900)
        fmt = "%Y-%m-%dT%H:%M:%S.0"
        return {
            "calendarDate": day,
            "sleepTimeSeconds": v["sleep"],
            "deepSleepSeconds": 5400,
            "lightSleepSeconds": v["sleep"] - 5400 - 6000,
            "remSleepSeconds": 6000,
            "awakeSleepSeconds": 900,
            "sleepStartTimestampLocal": start_local.strftime(fmt),
            "sleepEndTimestampLocal": end_local.strftime(fmt),
            "sleepStartTimestampGMT": (start_local - timedelta(hours=1)).strftime(fmt),
            "sleepEndTimestampGMT": (end_local - timedelta(hours=1)).strftime(fmt),
            "sleepScores": {"overall": {"value": 78, "qualifierKey": "FAIR"}},
        }

    @staticmethod
    def _hrv(day: str, v: dict[str, Any]) -> dict[str, Any]:
        return {
            "calendarDate": day,
            "weeklyAvg": 58,
            "lastNightAvg": v["hrv"],
            "baseline": {"lowUpper": 45, "balancedLow": 50, "balancedUpper": 66},
            "status": "BALANCED",
        }

    @staticmethod
    def _vo2(day: str, v: dict[str, Any]) -> dict[str, Any] | None:
        if v["vo2"] is None:
            return None
        return {"generic": {"calendarDate": day, "vo2MaxPreciseValue": v["vo2"], "vo2MaxValue": round(v["vo2"])}}

    @staticmethod
    def _body_battery(day: str, v: dict[str, Any]) -> dict[str, Any]:
        high, low, charged, drained = v["bb"]
        return {
            "date": day,
            "charged": charged,
            "drained": drained,
            "bodyBatteryValueDescriptorDTOList": [
                {"bodyBatteryValueDescriptorIndex": 0, "bodyBatteryValueDescriptorKey": "timestamp"},
                {"bodyBatteryValueDescriptorIndex": 1, "bodyBatteryValueDescriptorKey": "bodyBatteryLevel"},
            ],
            "bodyBatteryValuesArray": [[1, high], [2, low]],
        }

    def _weights(self, a: str, b: str) -> FakeResponse:
        da, db = _d(a), _d(b)
        if (db - da).days + 1 > 366:
            return FakeResponse(400, {"message": "intervallo troppo lungo"})
        summaries = []
        for day, kg in sorted(self.weights.items()):
            if a <= day <= b:
                summaries.append(
                    {
                        "summaryDate": day,
                        "numOfWeightEntries": 1,
                        "latestWeight": {"calendarDate": day, "weight": kg, "bodyFat": 18.0, "timestampGMT": 0},
                    }
                )
        before = [day for day in self.weights if day < a]
        prev = {"calendarDate": max(before), "weight": self.weights[max(before)]} if before else None
        return FakeResponse(200, {"dailyWeightSummaries": summaries, "previousDateWeight": prev})
