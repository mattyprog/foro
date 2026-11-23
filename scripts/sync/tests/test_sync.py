"""Sync completa e incrementale contro il server finto (dati SINTETICI)."""

from __future__ import annotations

import copy
import json
import unittest
from datetime import UTC, date, datetime, timedelta

import helpers  # noqa: F401
from fake_garmin import FAKE_API_KEY, FakeGarmin
from synthetic_fit import START_LAT, START_LON, run_fit, zipped

from garmin_bridge.api import GarminApi
from garmin_bridge.geo import haversine_m
from garmin_bridge.sync import SyncOptions, run_sync

TODAY = date(2026, 11, 20)
NOW = datetime(2026, 11, 20, 9, 23, tzinfo=UTC)


def run(fake: FakeGarmin, previous=None, today: date = TODAY, now: datetime = NOW, **opts):
    api = GarminApi(FAKE_API_KEY, session=fake, sleep=lambda _s: None, polite_delay=0)
    api.connect()
    try:
        return run_sync(api, previous, SyncOptions(**opts), today=today, now=now)
    finally:
        api.close()


def by_id(bundle):
    return {a["id"]: a for a in bundle["activities"]}


def wellness(bundle):
    return {w["date"]: w for w in bundle["wellness"]}


class FullSyncTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = FakeGarmin(TODAY)
        cls.bundle, cls.stats = run(cls.fake)

    def test_struttura_del_pacchetto(self):
        b = self.bundle
        self.assertEqual(b["version"], 1)
        self.assertEqual(b["generatedAt"], "2026-11-20T09:23:00Z")
        self.assertEqual(b["range"], {"from": "2025-11-20", "to": "2026-11-20"})
        self.assertEqual(b["warnings"], [])
        self.assertEqual(
            set(b), {"version", "generatedAt", "range", "activities", "wellness", "weights", "warnings", "syncState"}
        )
        json.dumps(b, allow_nan=False)  # serializzabile, niente NaN

    def test_attivita_degli_ultimi_12_mesi(self):
        ids = set(by_id(self.bundle))
        self.assertEqual(len(ids), 7)
        self.assertNotIn("garmin:9000000107", ids)  # 400 giorni fa
        run101 = by_id(self.bundle)["garmin:9000000101"]
        self.assertEqual(run101["kind"], "corsa")
        self.assertEqual(run101["distanceM"], 3000)
        self.assertTrue(run101["start"].endswith("+01:00"))

    def test_dettagli_fit_solo_ultimi_90_giorni(self):
        acts = by_id(self.bundle)
        run101 = acts["garmin:9000000101"]
        for key in ("laps", "track", "hrSeries", "paceSeries"):
            self.assertIn(key, run101)
        self.assertEqual(len(run101["laps"]), 3)
        strength = acts["garmin:9000000102"]
        self.assertEqual([s["category"] for s in strength["exerciseSets"]], ["BENCH_PRESS", "SQUAT"])
        # FIT senza messaggi 'set': ripiego sull'endpoint workouts
        self.assertEqual(
            acts["garmin:9000000108"]["exerciseSets"],
            [{"name": "Seated cable row", "category": "ROW", "reps": 12, "kg": 40.0}],
        )
        treadmill = acts["garmin:9000000103"]
        self.assertIn("laps", treadmill)
        self.assertNotIn("track", treadmill)
        walk = acts["garmin:9000000104"]  # file non disponibile (404)
        self.assertNotIn("laps", walk)
        self.assertIn("garmin:9000000104", self.bundle["syncState"]["fitDone"])
        for old in ("garmin:9000000105", "garmin:9000000106"):
            self.assertNotIn("track", acts[old])
        downloaded = {c[1].rsplit("/", 1)[-1] for c in self.fake.calls_to("/download-service")}
        self.assertEqual(downloaded, {"9000000101", "9000000102", "9000000103", "9000000104", "9000000108"})

    def test_privacy_niente_casa_niente_dati_personali(self):
        track = by_id(self.bundle)["garmin:9000000101"]["track"]
        for lat, lon in track:
            self.assertGreaterEqual(haversine_m(START_LAT, START_LON, lat, lon), 299)
        text = json.dumps(self.bundle)
        for forbidden in ("Olathe", "Utente Sintetico", "startLatitude", "38.8556", "ownerFullName"):
            self.assertNotIn(forbidden, text)

    def test_benessere_degli_ultimi_90_giorni(self):
        days = wellness(self.bundle)
        self.assertEqual(min(days), "2026-08-22")
        self.assertEqual(max(days), "2026-11-20")
        self.assertEqual(len(days), 91)
        d = days["2026-11-19"]
        self.assertEqual(d["source"], "garmin")
        self.assertEqual(d["steps"], self.fake.days["2026-11-19"]["steps"])
        for key in ("sleepSec", "sleepScore", "sleepStart", "hrvNightAvg", "hrvBaselineLow", "restingHr",
                    "stressAvg", "bodyBatteryHigh", "bodyBatteryCharged", "activeKcal", "totalKcal",
                    "spo2Avg", "respirationAvg"):
            self.assertIn(key, d)
        self.assertEqual(days["2026-11-20"]["fitnessAge"], 27.4)
        self.assertEqual(days["2026-11-20"]["vo2max"], 46.5)
        self.assertNotIn("vo2max", days["2026-11-19"])
        self.assertNotIn("hydrationMl", days["2026-11-19"])  # 0 ml = non registrata
        self.assertEqual(days["2026-11-18"]["hydrationMl"], 1200)

    def test_pesi_tutto_lo_storico(self):
        weights = self.bundle["weights"]
        self.assertEqual(len(weights), 105)
        self.assertEqual(weights[-1]["date"], "2026-11-20")
        self.assertEqual(weights[0]["source"], "garmin")
        # si torna indietro a blocchi di un anno finche' Garmin non segnala piu' pesate precedenti
        # e il blocco e' vuoto: 3 blocchi con dati + 1 vuoto
        self.assertEqual(len(self.fake.calls_to("/weight-service")), 4)

    def test_cursori(self):
        cursors = self.bundle["syncState"]["cursors"]
        for name in ("activities", "summary", "sleep", "hrv", "vo2max", "weights"):
            self.assertEqual(cursors[name]["to"], "2026-11-20", name)
        self.assertEqual(cursors["activities"]["from"], "2025-11-20")
        self.assertEqual(cursors["sleep"]["from"], "2026-08-22")

    def test_conteggi(self):
        self.assertEqual(self.stats.activities, 7)
        self.assertEqual(self.stats.activities_new, 7)
        self.assertEqual(self.stats.fit_parsed, 4)
        self.assertEqual(self.stats.fit_unavailable, 1)
        self.assertEqual(self.stats.wellness_days, 91)
        self.assertEqual(self.stats.weights, 105)


class IncrementalSyncTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = FakeGarmin(TODAY)
        cls.first, _ = run(cls.fake)
        f = cls.fake
        f.days["2026-11-19"]["steps"] = 12345  # Garmin rivede ieri: dentro la finestra di 3 giorni
        cls.old_steps = f.days["2026-11-10"]["steps"]
        f.days["2026-11-10"]["steps"] = 11111  # fuori finestra: non si riscarica
        del f.activities[9000000101]  # cancellata su Garmin (2 giorni fa)
        new_id = 9000000109
        dto, start_utc = f._activity(new_id, -1, 7, "trail_running", "Trail nuovo sintetico", 900.0, 3000.0)
        f.activities[new_id] = dto
        f.fit_files[new_id] = zipped(run_fit(start_utc, sub_sport="trail"))
        f.calls.clear()
        cls.second, cls.stats = run(
            f, previous=copy.deepcopy(cls.first), today=TODAY + timedelta(days=1), now=NOW + timedelta(days=1)
        )

    def test_scarica_solo_gli_ultimi_giorni(self):
        search = self.fake.calls_to("/activitylist-service")
        self.assertEqual(search[0][2]["startDate"], "2026-11-17")
        self.assertEqual(search[0][2]["endDate"], "2026-11-21")
        summary = self.fake.calls_to("/usersummary-service/v2/dailysummaries")
        self.assertEqual([(c[2]["startDate"], c[2]["endDate"]) for c in summary], [("2026-11-17", "2026-11-21")])
        self.assertEqual(
            [c[1] for c in self.fake.calls_to("/weight-service")], ["/weight-service/weight/range/2026-11-17/2026-11-21"]
        )

    def test_non_riscarica_i_fit(self):
        downloaded = [c[1].rsplit("/", 1)[-1] for c in self.fake.calls_to("/download-service")]
        self.assertEqual(downloaded, ["9000000109"])
        acts = by_id(self.second)
        self.assertIn("exerciseSets", acts["garmin:9000000102"])  # dettagli conservati
        self.assertIn("track", acts["garmin:9000000109"])
        self.assertEqual(acts["garmin:9000000109"]["kind"], "corsa")

    def test_cancellazione_nella_finestra(self):
        self.assertNotIn("garmin:9000000101", by_id(self.second))
        self.assertEqual(self.stats.activities_removed, 1)
        self.assertEqual(self.stats.activities_new, 1)

    def test_revisioni_di_garmin(self):
        days = wellness(self.second)
        self.assertEqual(days["2026-11-19"]["steps"], 12345)
        self.assertEqual(days["2026-11-10"]["steps"], self.old_steps)
        self.assertEqual(min(days), "2026-08-23")  # la finestra scorre di un giorno

    def test_cursori_avanzano(self):
        cursors = self.second["syncState"]["cursors"]
        self.assertEqual(cursors["activities"], {"from": "2025-11-21", "to": "2026-11-21"})
        self.assertEqual(self.second["range"], {"from": "2025-11-21", "to": "2026-11-21"})


class FailureTest(unittest.TestCase):
    def test_endpoint_che_fallisce_non_blocca(self):
        fake = FakeGarmin(TODAY)
        fake.fail["/hrv-service"] = 503
        bundle, stats = run(fake)
        self.assertTrue(any("HRV" in w and "503" in w for w in bundle["warnings"]))
        self.assertNotIn("hrv", bundle["syncState"]["cursors"])
        day = wellness(bundle)["2026-11-19"]
        self.assertNotIn("hrvNightAvg", day)
        self.assertIn("sleepSec", day)
        self.assertEqual(stats.activities, 7)
        # al giro dopo l'HRV torna: si riscarica tutta la finestra, non solo gli ultimi 3 giorni
        del fake.fail["/hrv-service"]
        fake.calls.clear()
        again, _ = run(fake, previous=bundle)
        hrv_calls = fake.calls_to("/hrv-service")
        self.assertEqual(hrv_calls[0][1], "/hrv-service/hrv/daily/2026-08-22/2026-09-18")
        self.assertIn("hrvNightAvg", wellness(again)["2026-11-19"])
        self.assertEqual(again["warnings"], [])

    def test_riepilogo_v2_assente_usa_gli_endpoint_singoli(self):
        fake = FakeGarmin(TODAY)
        fake.fail["/usersummary-service/v2"] = 403
        bundle, _ = run(fake)
        day = wellness(bundle)["2026-11-18"]
        self.assertEqual(day["steps"], fake.days["2026-11-18"]["steps"])
        self.assertEqual(day["stressAvg"], fake.days["2026-11-18"]["stress"])
        self.assertEqual(day["bodyBatteryHigh"], fake.days["2026-11-18"]["bb"][0])
        self.assertEqual(day["hydrationMl"], 1200)
        self.assertNotIn("restingHr", day)
        self.assertTrue(any("Riepilogo" in w for w in bundle["warnings"]))
        self.assertNotIn("summary", bundle["syncState"]["cursors"])

    def test_fit_temporaneamente_non_disponibile_si_riprova(self):
        fake = FakeGarmin(TODAY)
        fake.fail["/download-service/files/activity/9000000101"] = 503
        bundle, stats = run(fake)
        self.assertNotIn("garmin:9000000101", bundle["syncState"]["fitDone"])
        self.assertEqual(stats.fit_retry, 1)
        self.assertTrue(any("riprovare" in w for w in bundle["warnings"]))
        del fake.fail["/download-service/files/activity/9000000101"]
        fake.calls.clear()
        again, _ = run(fake, previous=bundle)
        downloaded = [c[1].rsplit("/", 1)[-1] for c in fake.calls_to("/download-service")]
        self.assertEqual(downloaded, ["9000000101"])
        self.assertIn("track", by_id(again)["garmin:9000000101"])

    def test_elenco_attivita_non_disponibile_conserva_le_precedenti(self):
        fake = FakeGarmin(TODAY)
        first, _ = run(fake)
        fake.fail["/activitylist-service"] = 500
        second, _ = run(fake, previous=copy.deepcopy(first), today=TODAY + timedelta(days=1), now=NOW + timedelta(days=1))
        self.assertEqual(set(by_id(second)), set(by_id(first)))
        self.assertEqual(second["syncState"]["cursors"]["activities"], first["syncState"]["cursors"]["activities"])
        self.assertTrue(any("Attività" in w for w in second["warnings"]))

    def test_messaggi_di_avviso_senza_dati(self):
        fake = FakeGarmin(TODAY)
        for prefix in ("/hrv-service", "/sleep-service", "/metrics-service", "/weight-service", "/fitnessage-service"):
            fake.fail[prefix] = 500
        bundle, _ = run(fake)
        self.assertEqual(len(bundle["warnings"]), 5)
        for w in bundle["warnings"]:
            self.assertNotRegex(w, r"\d{4}-\d{2}-\d{2}")
            self.assertNotRegex(w, r"9000000\d+")


class PruneAndPreviousTest(unittest.TestCase):
    def test_potatura_delle_finestre(self):
        fake = FakeGarmin(TODAY)
        first, _ = run(fake)
        prev = copy.deepcopy(first)
        prev["activities"].append(
            {"id": "garmin:1", "source": "garmin", "kind": "corsa", "typeKey": "running", "name": "Vecchia",
             "start": "2025-11-01T08:00:00+01:00", "durationSec": 1000}
        )
        prev["wellness"].append({"date": "2026-01-01", "source": "garmin", "steps": 5000})
        later = TODAY + timedelta(days=100)
        fake2 = FakeGarmin(later)
        fake2.activities = {k: v for k, v in fake.activities.items()}
        bundle, _ = run(fake2, previous=prev, today=later, now=NOW + timedelta(days=100))
        acts = by_id(bundle)
        self.assertNotIn("garmin:1", acts)
        # la corsa di 102 giorni fa resta come riepilogo, senza dettagli FIT
        self.assertIn("garmin:9000000101", acts)
        self.assertNotIn("track", acts["garmin:9000000101"])
        self.assertNotIn("garmin:9000000101", bundle["syncState"]["fitDone"])
        self.assertNotIn("2026-01-01", wellness(bundle))

    def test_pacchetto_precedente_non_valido(self):
        fake = FakeGarmin(TODAY)
        bundle, _ = run(fake, previous={"version": 7, "activities": "boh"})
        self.assertEqual(len(bundle["activities"]), 7)
        self.assertTrue(any("precedente" in w for w in bundle["warnings"]))

    def test_risincronizzazione_completa(self):
        fake = FakeGarmin(TODAY)
        first, _ = run(fake)
        fake.calls.clear()
        run(fake, previous=copy.deepcopy(first), full=True)
        self.assertEqual(len(fake.calls_to("/download-service")), 5)
        self.assertEqual(fake.calls_to("/activitylist-service")[0][2]["startDate"], "2025-11-20")


if __name__ == "__main__":
    unittest.main()
