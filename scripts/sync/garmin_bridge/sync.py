"""Sync incrementale: scarica da Garmin solo il nuovo, lo unisce al pacchetto precedente, pota le finestre.

Finestre (tutte terminano oggi, data locale):
- attivita' (riepiloghi): `activity_days` (365); dettagli FIT solo per gli ultimi `fit_days` (90);
- benessere: `wellness_days` (90);
- peso: tutto lo storico.

Incrementale: per ogni gruppo di dati il pacchetto conserva in `syncState.cursors` l'intervallo gia'
scaricato. Al giro dopo si riscarica solo da `cursor.to - rewrite_days` (3 giorni: Garmin rivede
passi, FC a riposo, sonno...) a oggi. Un gruppo che fallisce non avanza il suo cursore: al giro
successivo si riprova da dove era rimasto. I FIT gia' elaborati (o assenti) sono in `syncState.fitDone`
e non si riscaricano.

Dentro l'intervallo riscaricato i dati di Garmin fanno fede: un'attivita' cancellata su Garmin
sparisce, un valore rivisto viene sostituito. Fuori dall'intervallo resta quello del pacchetto precedente.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta, tzinfo
from typing import Any
from zoneinfo import ZoneInfo

from . import normalize as N
from .api import EndpointError, GarminApi
from .fitparse import FitError, parse_fit_details

BUNDLE_VERSION = 1
DETAIL_FIELDS = ("laps", "track", "hrSeries", "paceSeries", "exerciseSets")
# Massimo di giorni per richiesta (dallo swagger; dove non e' scritto, valore prudente).
CHUNK_DAYS = {
    "summary": 364,
    "sleep": 30,
    "hrv": 28,
    "vo2max": 28,
    "steps": 28,
    "stress": 28,
    "body_battery": 30,
    "hydration": 30,
    "weights": 364,
}
ACTIVITY_PAGE = 99
MAX_ACTIVITY_PAGES = 60
WEIGHT_HISTORY_START = date(2000, 1, 1)


@dataclass
class SyncOptions:
    activity_days: int = 365
    fit_days: int = 90
    wellness_days: int = 90
    rewrite_days: int = 3
    privacy_trim_m: float = 300.0
    max_fit_downloads: int = 150
    full: bool = False
    tz: tzinfo = field(default_factory=lambda: ZoneInfo("Europe/Rome"))


@dataclass
class SyncStats:
    activities: int = 0
    activities_new: int = 0
    activities_updated: int = 0
    activities_removed: int = 0
    fit_parsed: int = 0
    fit_unavailable: int = 0
    fit_unreadable: int = 0
    fit_retry: int = 0
    wellness_days: int = 0
    weights: int = 0
    warnings: int = 0
    requests: int = 0


def _status(exc: EndpointError) -> str:
    return f"HTTP {exc.status}" if exc.status else "rete"


def _iso(d: date) -> str:
    return d.isoformat()


def _parse_day(value: Any) -> date | None:
    try:
        return date.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


# ------------------------------------------------------------------ pacchetto precedente


def sanitize_previous(previous: Any) -> dict[str, Any] | None:
    """Tiene solo le parti valide del pacchetto precedente; None se non e' un SyncBundle v1."""
    if not isinstance(previous, Mapping) or previous.get("version") != BUNDLE_VERSION:
        return None
    lists = [previous.get(k) for k in ("activities", "wellness", "weights")]
    if not all(isinstance(x, list) for x in lists):
        return None
    acts = [a for a in previous["activities"] if isinstance(a, dict) and isinstance(a.get("id"), str) and isinstance(a.get("start"), str)]
    well = [w for w in previous["wellness"] if isinstance(w, dict) and _parse_day(w.get("date"))]
    weights = [w for w in previous["weights"] if isinstance(w, dict) and _parse_day(w.get("date")) and isinstance(w.get("kg"), (int, float))]
    raw_state = previous.get("syncState")
    state: Mapping[str, Any] = raw_state if isinstance(raw_state, Mapping) else {}
    raw_cursors = state.get("cursors")
    cursors: Mapping[str, Any] = raw_cursors if isinstance(raw_cursors, Mapping) else {}
    raw_done = state.get("fitDone")
    fit_done = [x for x in raw_done if isinstance(x, str)] if isinstance(raw_done, list) else []
    return {
        "activities": acts,
        "wellness": well,
        "weights": weights,
        "cursors": {k: dict(v) for k, v in cursors.items() if isinstance(v, Mapping)},
        "fitDone": fit_done,
    }


# ------------------------------------------------------------------ motore


class _Sync:
    def __init__(self, api: GarminApi, previous: Any, opts: SyncOptions, today: date, now: datetime):
        self.api = api
        self.opts = opts
        self.today = today
        self.now = now
        self.warnings: list[str] = []
        self.stats = SyncStats()
        prev = sanitize_previous(previous) if previous is not None else None
        if previous is not None and prev is None:
            self.warnings.append("Pacchetto precedente non valido: risincronizzazione completa.")
        prev = prev or {"activities": [], "wellness": [], "weights": [], "cursors": {}, "fitDone": []}
        self.activities: dict[str, dict[str, Any]] = {a["id"]: dict(a) for a in prev["activities"]}
        self.wellness: dict[str, dict[str, Any]] = {}
        for w in prev["wellness"]:
            self.wellness[w["date"]] = {k: v for k, v in w.items() if k not in ("date", "source")}
        self.weights: dict[str, dict[str, Any]] = {w["date"]: dict(w) for w in prev["weights"]}
        self.cursors: dict[str, dict[str, str]] = {} if opts.full else prev["cursors"]
        self.fit_done: set[str] = set() if opts.full else set(prev["fitDone"])
        self.act_from = today - timedelta(days=opts.activity_days)
        self.fit_from = today - timedelta(days=opts.fit_days)
        self.well_from = today - timedelta(days=opts.wellness_days)

    # -------------------------------------------------------------- cursori

    def fetch_start(self, name: str, window_from: date) -> date:
        cursor = self.cursors.get(name)
        if self.opts.full or not cursor:
            return window_from
        c_from, c_to = _parse_day(cursor.get("from")), _parse_day(cursor.get("to"))
        if c_from is None or c_to is None or c_from > window_from or c_to > self.today:
            return window_from
        return max(window_from, c_to - timedelta(days=self.opts.rewrite_days))

    def advance(self, name: str, window_from: date) -> None:
        self.cursors[name] = {"from": _iso(window_from), "to": _iso(self.today)}

    def chunked(self, name: str, start: date, fn: Callable[[str, str], Any]) -> list[Any]:
        """Chiama fn(a, b) su blocchi di date; un solo blocco fallito fa fallire tutto il gruppo."""
        return [fn(a, b) for a, b in N.date_range_chunks(_iso(start), _iso(self.today), CHUNK_DAYS[name])]

    # -------------------------------------------------------------- attivita'

    def sync_activities(self) -> None:
        start = self.fetch_start("activities", self.act_from)
        try:
            dtos: list[Any] = []
            for page in range(MAX_ACTIVITY_PAGES):
                batch = self.api.get_json(
                    "/activitylist-service/activities/search/activities",
                    {"start": page * ACTIVITY_PAGE, "limit": ACTIVITY_PAGE, "startDate": _iso(start), "endDate": _iso(self.today)},
                )
                batch = batch if isinstance(batch, list) else []
                dtos.extend(batch)
                if len(batch) < ACTIVITY_PAGE:
                    break
        except EndpointError as exc:
            self.warnings.append(f"Attività: elenco non disponibile ({_status(exc)}). Restano quelle della sync precedente.")
            return
        fresh: dict[str, dict[str, Any]] = {}
        for dto in dtos:
            if isinstance(dto, Mapping):
                act = N.activity_from_summary(dto, self.opts.tz)
                if act is not None:
                    fresh[act["id"]] = act
        a, b = _iso(start), _iso(self.today)
        for aid in [i for i, act in self.activities.items() if a <= N.local_date_of(act["start"]) <= b]:
            if aid not in fresh:
                del self.activities[aid]
                self.fit_done.discard(aid)
                self.stats.activities_removed += 1
        for aid, act in fresh.items():
            old = self.activities.get(aid)
            if old is None:
                self.stats.activities_new += 1
            else:
                for key in DETAIL_FIELDS:
                    if key in old:
                        act[key] = old[key]
                if act != old:
                    self.stats.activities_updated += 1
            self.activities[aid] = act
        self.advance("activities", self.act_from)

    def sync_fit_details(self) -> None:
        fit_from = _iso(self.fit_from)
        candidates = [
            act
            for act in self.activities.values()
            if N.local_date_of(act["start"]) >= fit_from
            and act["id"] not in self.fit_done
            and N.garmin_activity_id(act["id"])
            and (self.opts.full or not any(k in act for k in DETAIL_FIELDS))
        ]
        candidates.sort(key=lambda x: x["start"], reverse=True)
        if len(candidates) > self.opts.max_fit_downloads:
            self.warnings.append(
                f"Limite di {self.opts.max_fit_downloads} file FIT per giro raggiunto: gli altri al prossimo giro."
            )
            candidates = candidates[: self.opts.max_fit_downloads]
        for act in candidates:
            gid = N.garmin_activity_id(act["id"])
            assert gid is not None
            try:
                details = parse_fit_details(self.api.download_activity(gid), kind=act["kind"], privacy_trim_m=self.opts.privacy_trim_m)
            except EndpointError as exc:
                if exc.permanent:
                    # es. attivita' inserita a mano: Garmin non ha un file originale. Non e' un problema.
                    self.fit_done.add(act["id"])
                    self.stats.fit_unavailable += 1
                else:
                    self.stats.fit_retry += 1
                continue
            except FitError:
                self.fit_done.add(act["id"])
                self.stats.fit_unreadable += 1
                continue
            if act["kind"] == "forza" and not details.get("exerciseSets"):
                try:
                    sets = N.exercise_sets_from_workouts(self.api.get_json(f"/activity-service/activity/{gid}/workouts"))
                except EndpointError:
                    sets = []
                if sets:
                    details["exerciseSets"] = sets
            for key in DETAIL_FIELDS:
                act.pop(key, None)
            act.update(details)
            self.fit_done.add(act["id"])
            self.stats.fit_parsed += 1
        if self.stats.fit_unreadable:
            self.warnings.append(f"File FIT: {self.stats.fit_unreadable} illeggibili (restano solo i riepiloghi).")
        if self.stats.fit_retry:
            self.warnings.append(f"File FIT: {self.stats.fit_retry} da riprovare al prossimo giro.")

    # -------------------------------------------------------------- benessere

    def apply_wellness(self, days: Mapping[str, Mapping[str, Any]], fields: tuple[str, ...], start: date, end: date) -> None:
        """Dentro [start, end] i campi `fields` vengono sostituiti da quelli appena scaricati."""
        d = start
        while d <= end:
            key = _iso(d)
            day = self.wellness.get(key, {})
            for f in fields:
                day.pop(f, None)
            for f, v in (days.get(key) or {}).items():
                if f in fields and v is not None:
                    day[f] = v
            if day:
                self.wellness[key] = day
            else:
                self.wellness.pop(key, None)
            d += timedelta(days=1)

    def _merge_days(self, parts: list[dict[str, dict[str, Any]]]) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for part in parts:
            for day, fields in part.items():
                out.setdefault(day, {}).update(fields)
        return out

    def sync_summary(self) -> None:
        start = self.fetch_start("summary", self.well_from)
        try:
            parts = self.chunked(
                "summary",
                start,
                lambda a, b: N.wellness_from_daily_summaries(
                    self.api.get_json("/usersummary-service/v2/dailysummaries", {"startDate": a, "endDate": b})
                ),
            )
        except EndpointError as exc:
            self.warnings.append(
                f"Riepilogo giornaliero non disponibile ({_status(exc)}): passi, stress, Body Battery e idratazione dagli endpoint singoli."
            )
            self.summary_fallback(start)
            return
        self.apply_wellness(self._merge_days(parts), N.SUMMARY_FIELDS, start, self.today)
        self.advance("summary", self.well_from)

    def summary_fallback(self, start: date) -> None:
        sources = [
            ("steps", N.STEPS_FALLBACK_FIELDS, lambda a, b: N.wellness_from_steps_stats(self.api.get_json(f"/usersummary-service/stats/steps/daily/{a}/{b}"))),
            ("stress", N.STRESS_FALLBACK_FIELDS, lambda a, b: N.wellness_from_stress_stats(self.api.get_json(f"/usersummary-service/stats/stress/daily/{a}/{b}"))),
            (
                "body_battery",
                N.BODY_BATTERY_FALLBACK_FIELDS,
                lambda a, b: N.wellness_from_body_battery(
                    self.api.get_json("/wellness-service/wellness/bodyBattery/reports/daily", {"startDate": a, "endDate": b})
                ),
            ),
            ("hydration", N.HYDRATION_FALLBACK_FIELDS, lambda a, b: N.wellness_from_hydration_stats(self.api.get_json(f"/usersummary-service/stats/hydration/daily/{a}/{b}"))),
        ]
        for name, fields, fn in sources:
            try:
                parts = self.chunked(name, start, fn)
            except EndpointError:
                continue
            self.apply_wellness(self._merge_days(parts), fields, start, self.today)

    def sync_wellness_source(self, name: str, label: str, fields: tuple[str, ...], fn: Callable[[str, str], dict[str, dict[str, Any]]]) -> None:
        start = self.fetch_start(name, self.well_from)
        try:
            parts = self.chunked(name, start, fn)
        except EndpointError as exc:
            self.warnings.append(f"{label} non disponibile ({_status(exc)}).")
            return
        self.apply_wellness(self._merge_days(parts), fields, start, self.today)
        self.advance(name, self.well_from)

    def sync_fitness_age(self) -> None:
        today = _iso(self.today)
        try:
            value = N.fitness_age_from(self.api.get_json(f"/fitnessage-service/fitnessage/v2/{today}"))
        except EndpointError as exc:
            self.warnings.append(f"Età fitness non disponibile ({_status(exc)}).")
            return
        self.apply_wellness({today: {"fitnessAge": value}}, N.FITNESS_AGE_FIELDS, self.today, self.today)

    # -------------------------------------------------------------- peso

    def sync_weights(self) -> None:
        cursor = None if self.opts.full else self.cursors.get("weights")
        c_from = _parse_day(cursor.get("from")) if cursor else None
        c_to = _parse_day(cursor.get("to")) if cursor else None
        try:
            if c_from is not None and c_to is not None and c_to <= self.today:
                # incrementale: solo gli ultimi giorni (il peso storico non cambia)
                start = max(c_from, c_to - timedelta(days=self.opts.rewrite_days))
                found: dict[str, dict[str, Any]] = {}
                for a, b in N.date_range_chunks(_iso(start), _iso(self.today), CHUNK_DAYS["weights"]):
                    found.update(N.weights_from_range(self.api.get_json(f"/weight-service/weight/range/{a}/{b}")))
                earliest = c_from
            else:
                # tutto lo storico: a blocchi di un anno all'indietro finche' Garmin segnala pesate precedenti
                found = {}
                end = self.today
                start = end
                while end >= WEIGHT_HISTORY_START:
                    start = max(WEIGHT_HISTORY_START, end - timedelta(days=CHUNK_DAYS["weights"] - 1))
                    resp = self.api.get_json(f"/weight-service/weight/range/{_iso(start)}/{_iso(end)}")
                    chunk = N.weights_from_range(resp)
                    found.update(chunk)
                    # previousDateWeight dice se esistono pesate piu' vecchie; se Garmin non lo
                    # compilasse, si continua finche' i blocchi contengono pesate.
                    if not N.has_previous_weight(resp) and not chunk:
                        break
                    end = start - timedelta(days=1)
                earliest = start
        except EndpointError as exc:
            self.warnings.append(f"Peso non disponibile ({_status(exc)}).")
            return
        a, b = _iso(start), _iso(self.today)
        for day in [d for d in self.weights if a <= d <= b]:
            if day not in found:
                del self.weights[day]
        self.weights.update(found)
        self.cursors["weights"] = {"from": _iso(earliest), "to": _iso(self.today)}

    # -------------------------------------------------------------- insieme

    def run(self) -> tuple[dict[str, Any], SyncStats]:
        self.sync_activities()
        self.sync_fit_details()
        self.sync_summary()
        tz = self.opts.tz
        self.sync_wellness_source(
            "sleep",
            "Sonno",
            N.SLEEP_FIELDS,
            lambda a, b: N.wellness_from_sleep(
                self.api.get_json("/sleep-service/sleep/dailySleepSummariesByDate", {"startDate": a, "endDate": b}), tz
            ),
        )
        self.sync_wellness_source(
            "hrv", "HRV", N.HRV_FIELDS, lambda a, b: N.wellness_from_hrv(self.api.get_json(f"/hrv-service/hrv/daily/{a}/{b}"))
        )
        self.sync_wellness_source(
            "vo2max",
            "VO2max",
            N.VO2_FIELDS,
            lambda a, b: N.wellness_from_vo2max(self.api.get_json(f"/metrics-service/metrics/maxmet/daily/{a}/{b}")),
        )
        self.sync_fitness_age()
        self.sync_weights()
        return self.build()

    def build(self) -> tuple[dict[str, Any], SyncStats]:
        act_from, fit_from, well_from = _iso(self.act_from), _iso(self.fit_from), _iso(self.well_from)
        activities = []
        for act in self.activities.values():
            day = N.local_date_of(act["start"])
            if day < act_from:
                continue
            if day < fit_from:
                act = {k: v for k, v in act.items() if k not in DETAIL_FIELDS}
            activities.append(act)
        activities.sort(key=lambda a: (a["start"], a["id"]))
        kept = {a["id"] for a in activities if N.local_date_of(a["start"]) >= fit_from}
        wellness = [
            {"date": day, "source": "garmin", **fields}
            for day, fields in sorted(self.wellness.items())
            if day >= well_from and fields
        ]
        weights = [self.weights[d] for d in sorted(self.weights)]
        bundle = {
            "version": BUNDLE_VERSION,
            "generatedAt": self.now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "range": {"from": min(act_from, well_from), "to": _iso(self.today)},
            "activities": activities,
            "wellness": wellness,
            "weights": weights,
            "warnings": self.warnings,
            "syncState": {
                "cursors": dict(sorted(self.cursors.items())),
                "fitDone": sorted(self.fit_done & kept),
            },
        }
        s = self.stats
        s.activities = len(activities)
        s.wellness_days = len(wellness)
        s.weights = len(weights)
        s.warnings = len(self.warnings)
        s.requests = self.api.requests_made
        return bundle, s


def run_sync(api: GarminApi, previous: Any, opts: SyncOptions, *, today: date, now: datetime) -> tuple[dict[str, Any], SyncStats]:
    """Esegue una sync (completa o incrementale) e restituisce (SyncBundle, conteggi)."""
    return _Sync(api, previous, opts, today, now).run()
