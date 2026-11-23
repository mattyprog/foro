"""Normalizzazione: dalle risposte JSON della Personal API (schemi dello swagger) al contratto SyncBundle.

Tutti i valori sono SINTETICI.
"""

from __future__ import annotations

import unittest
from zoneinfo import ZoneInfo

import helpers  # noqa: F401

from garmin_bridge import normalize as N

ROME = ZoneInfo("Europe/Rome")


def run_dto(**over):
    dto = {
        "activityId": 90000000001,
        "activityName": "Corsa facile di prova",
        "startTimeLocal": "2026-11-18 07:30:05",
        "startTimeGMT": "2026-11-18 06:30:05",
        "activityType": {"typeId": 1, "typeKey": "running", "parentTypeId": 17},
        "distance": 3000.0,
        "duration": 1080.4,
        "elapsedDuration": 1100.0,
        "movingDuration": 1075.2,
        "elevationGain": 12.0,
        "averageSpeed": 2.7777,
        "calories": 210.0,
        "averageHR": 148.6,
        "maxHR": 171.0,
        "averageRunningCadenceInStepsPerMinute": 166.4,
        "aerobicTrainingEffect": 2.84,
        "anaerobicTrainingEffect": 0.3,
        "activityTrainingLoad": 61.27,
        "hrTimeInZone_1": 60.0,
        "hrTimeInZone_2": 600.4,
        "hrTimeInZone_3": 400.0,
        "hrTimeInZone_4": 20.0,
        "startLatitude": 38.8556,
        "startLongitude": -94.799,
        "locationName": "Olathe",
        "ownerFullName": "Nome Finto",
    }
    dto.update(over)
    return dto


class KindTest(unittest.TestCase):
    def test_mappa_dei_tipi(self):
        cases = {
            "running": "corsa",
            "trail_running": "corsa",
            "treadmill_running": "corsa",
            "track_running": "corsa",
            "strength_training": "forza",
            "walking": "camminata",
            "hiking": "camminata",
            "cycling": "bici",
            "road_biking": "bici",
            "indoor_cycling": "bici",
            "virtual_ride": "bici",
            "lap_swimming": "nuoto",
            "open_water_swimming": "nuoto",
            "yoga": "altro",
            "": "altro",
            None: "altro",
        }
        for key, kind in cases.items():
            with self.subTest(key=key):
                self.assertEqual(N.kind_from_type_key(key), kind)


class TimeTest(unittest.TestCase):
    def test_offset_da_ora_locale_e_gmt(self):
        self.assertEqual(
            N.iso_from_pair("2026-11-18 07:30:05", "2026-11-18 06:30:05", ROME), "2026-11-18T07:30:05+01:00"
        )
        self.assertEqual(
            N.iso_from_pair("2026-07-01T07:00:00.0", "2026-07-01T05:00:00.0", ROME), "2026-07-01T07:00:00+02:00"
        )

    def test_millisecondi_epoch(self):
        # 2026-11-17 22:40:00 UTC = 23:40 a Roma
        gmt = 1_794_955_200_000
        local = gmt + 3_600_000
        self.assertEqual(N.iso_from_pair(local, gmt, ROME), "2026-11-17T23:40:00+01:00")

    def test_solo_gmt_usa_il_fuso_di_ripiego(self):
        self.assertEqual(N.iso_from_pair(None, "2026-11-18 06:30:05", ROME), "2026-11-18T07:30:05+01:00")

    def test_niente_orari(self):
        self.assertIsNone(N.iso_from_pair(None, None, ROME))


class ActivityTest(unittest.TestCase):
    def test_corsa_dal_riepilogo(self):
        act = N.activity_from_summary(run_dto(), ROME)
        self.assertEqual(act["id"], "garmin:90000000001")
        self.assertEqual(act["source"], "garmin")
        self.assertEqual(act["kind"], "corsa")
        self.assertEqual(act["typeKey"], "running")
        self.assertEqual(act["start"], "2026-11-18T07:30:05+01:00")
        self.assertEqual(act["durationSec"], 1080)
        self.assertEqual(act["movingSec"], 1075)
        self.assertEqual(act["distanceM"], 3000)
        self.assertEqual(act["avgHr"], 149)
        self.assertEqual(act["maxHr"], 171)
        self.assertEqual(act["calories"], 210)
        self.assertEqual(act["elevGainM"], 12)
        self.assertEqual(act["avgPaceSecPerKm"], 360)
        self.assertEqual(act["avgCadence"], 166)
        self.assertEqual(act["aerobicTE"], 2.8)
        self.assertEqual(act["anaerobicTE"], 0.3)
        self.assertEqual(act["trainingLoad"], 61.3)
        self.assertEqual(act["hrZonesSec"], [60, 600, 400, 20, 0])

    def test_nessun_dato_di_posizione_o_personale(self):
        act = N.activity_from_summary(run_dto(), ROME)
        text = repr(act)
        for forbidden in ("38.85", "94.79", "Olathe", "Nome Finto", "startLatitude"):
            self.assertNotIn(forbidden, text)

    def test_campi_mancanti_restano_assenti(self):
        dto = {
            "activityId": 90000000002,
            "startTimeLocal": "2026-11-19 18:00:00",
            "startTimeGMT": "2026-11-19 17:00:00",
            "activityType": {"typeKey": "strength_training"},
            "duration": 2400.0,
            "distance": 0.0,
            "averageSpeed": 0.0,
            "averageHR": None,
        }
        act = N.activity_from_summary(dto, ROME)
        self.assertEqual(act["kind"], "forza")
        self.assertEqual(act["name"], "Forza")
        for key in ("distanceM", "avgPaceSecPerKm", "avgHr", "hrZonesSec", "calories"):
            self.assertNotIn(key, act)
        self.assertNotIn(None, act.values())

    def test_senza_id_o_orario_scartata(self):
        self.assertIsNone(N.activity_from_summary({"activityType": {"typeKey": "running"}}, ROME))
        self.assertIsNone(N.activity_from_summary({"activityId": 5}, ROME))


class WellnessTest(unittest.TestCase):
    def test_riepilogo_giornaliero_v2(self):
        resp = {
            "data": [
                {
                    "calendarDate": "2026-11-18",
                    "includesWellnessData": True,
                    "movement": {"steps": {"goal": 8000, "value": 9123}},
                    "calories": {"burnedActive": 612, "burnedTotal": 2480, "burnedResting": 1868},
                    "heartRate": {"restingValue": 54, "minValue": 50, "maxValue": 171},
                    "stress": {"avgLevel": 31, "maxLevel": 90},
                    "bodyBattery": {"minValue": 18, "maxValue": 84, "chargedValue": 60, "drainedValue": 64},
                    "hydration": {"consumedInFractionalMl": 1500.0},
                    "respiration": {"avgValue": 14},
                    "pulseOx": {"avgValue": 96},
                },
                {
                    "calendarDate": "2026-11-19",
                    "includesWellnessData": False,
                    "movement": {"steps": {"value": 0}},
                    "stress": {"avgLevel": -1},
                    "hydration": {"consumedInFractionalMl": 0},
                    "heartRate": {"restingValue": 0},
                },
            ]
        }
        days = N.wellness_from_daily_summaries(resp)
        self.assertEqual(
            days["2026-11-18"],
            {
                "steps": 9123,
                "activeKcal": 612,
                "totalKcal": 2480,
                "restingHr": 54,
                "stressAvg": 31,
                "bodyBatteryHigh": 84,
                "bodyBatteryLow": 18,
                "bodyBatteryCharged": 60,
                "bodyBatteryDrained": 64,
                "hydrationMl": 1500,
                "respirationAvg": 14,
                "spo2Avg": 96,
            },
        )
        self.assertEqual(days.get("2026-11-19", {}), {})

    def test_sonno(self):
        resp = [
            {
                "calendarDate": "2026-11-18",
                "sleepTimeSeconds": 25200,
                "deepSleepSeconds": 5400,
                "lightSleepSeconds": 13800,
                "remSleepSeconds": 6000,
                "awakeSleepSeconds": 900,
                "sleepStartTimestampGMT": "2026-11-17T22:40:00.0",
                "sleepEndTimestampGMT": "2026-11-18T05:55:00.0",
                "sleepStartTimestampLocal": "2026-11-17T23:40:00.0",
                "sleepEndTimestampLocal": "2026-11-18T06:55:00.0",
                "sleepScores": {"overall": {"value": 81, "qualifierKey": "GOOD"}},
                "averageSpO2Value": 95.0,
            }
        ]
        day = N.wellness_from_sleep(resp, ROME)["2026-11-18"]
        self.assertEqual(day["sleepSec"], 25200)
        self.assertEqual(day["deepSec"], 5400)
        self.assertEqual(day["lightSec"], 13800)
        self.assertEqual(day["remSec"], 6000)
        self.assertEqual(day["awakeSec"], 900)
        self.assertEqual(day["sleepScore"], 81)
        self.assertEqual(day["sleepStart"], "2026-11-17T23:40:00+01:00")
        self.assertEqual(day["sleepEnd"], "2026-11-18T06:55:00+01:00")

    def test_hrv(self):
        resp = {
            "hrvSummaries": [
                {
                    "calendarDate": "2026-11-18",
                    "weeklyAvg": 58,
                    "lastNightAvg": 61,
                    "baseline": {"lowUpper": 45, "balancedLow": 50, "balancedUpper": 66},
                    "status": "BALANCED",
                },
                {"calendarDate": "2026-11-19", "status": "NONE"},
            ]
        }
        days = N.wellness_from_hrv(resp)
        self.assertEqual(
            days["2026-11-18"],
            {"hrvNightAvg": 61, "hrvWeeklyAvg": 58, "hrvBaselineLow": 50, "hrvBaselineHigh": 66, "hrvStatus": "BALANCED"},
        )
        self.assertEqual(days.get("2026-11-19", {}), {})

    def test_vo2max_e_eta_fitness(self):
        vo2 = [{"generic": {"calendarDate": "2026-11-18", "vo2MaxPreciseValue": 47.26, "vo2MaxValue": 47.0}}]
        self.assertEqual(N.wellness_from_vo2max(vo2), {"2026-11-18": {"vo2max": 47.3}})
        self.assertEqual(N.fitness_age_from([{"chronologicalAge": 30, "fitnessAge": 27.43}]), 27.4)
        self.assertIsNone(N.fitness_age_from([{"invalidReason": "USER_EMPTY_AGE"}]))

    def test_ripieghi_passi_stress_body_battery_idratazione(self):
        steps = N.wellness_from_steps_stats([{"calendarDate": "2026-11-18", "totalSteps": 8000}])
        stress = N.wellness_from_stress_stats([{"calendarDate": "2026-11-18", "values": {"overallStressLevel": 29}}])
        bb = N.wellness_from_body_battery(
            [
                {
                    "date": "2026-11-18",
                    "charged": 55,
                    "drained": 60,
                    "bodyBatteryValueDescriptorDTOList": [
                        {"bodyBatteryValueDescriptorIndex": 0, "bodyBatteryValueDescriptorKey": "timestamp"},
                        {"bodyBatteryValueDescriptorIndex": 1, "bodyBatteryValueDescriptorKey": "bodyBatteryLevel"},
                    ],
                    "bodyBatteryValuesArray": [[1, 20], [2, 81], [3, None], [4, 35]],
                }
            ]
        )
        hydration = N.wellness_from_hydration_stats([{"calendarDate": "2026-11-18", "valueInML": 1250.0}])
        self.assertEqual(steps, {"2026-11-18": {"steps": 8000}})
        self.assertEqual(stress, {"2026-11-18": {"stressAvg": 29}})
        self.assertEqual(
            bb,
            {"2026-11-18": {"bodyBatteryHigh": 81, "bodyBatteryLow": 20, "bodyBatteryCharged": 55, "bodyBatteryDrained": 60}},
        )
        self.assertEqual(hydration, {"2026-11-18": {"hydrationMl": 1250}})


class WeightTest(unittest.TestCase):
    def test_pesi_dal_riepilogo_giornaliero(self):
        resp = {
            "dailyWeightSummaries": [
                {"summaryDate": "2026-11-18", "latestWeight": {"calendarDate": "2026-11-18", "weight": 72.46, "bodyFat": 17.24}},
                {"summaryDate": "2026-11-10", "latestWeight": {"calendarDate": "2026-11-10", "weight": 72800.0}},
                {"summaryDate": "2026-11-01", "latestWeight": {"weight": None}},
            ],
            "previousDateWeight": {"calendarDate": "2025-01-02", "weight": 75.0},
        }
        weights = N.weights_from_range(resp)
        self.assertEqual(weights["2026-11-18"], {"date": "2026-11-18", "kg": 72.46, "source": "garmin", "bodyFatPct": 17.2})
        self.assertEqual(weights["2026-11-10"], {"date": "2026-11-10", "kg": 72.8, "source": "garmin"})
        self.assertNotIn("2026-11-01", weights)
        self.assertTrue(N.has_previous_weight(resp))
        self.assertFalse(N.has_previous_weight({"dailyWeightSummaries": []}))


class ExerciseTest(unittest.TestCase):
    def test_chiavi_e_nomi_leggibili(self):
        self.assertEqual(N.exercise_key("bench_press"), "BENCH_PRESS")
        self.assertEqual(N.exercise_key("barbellBenchPress"), "BARBELL_BENCH_PRESS")
        self.assertEqual(N.exercise_key("3WayCalfRaise"), "3_WAY_CALF_RAISE")
        self.assertEqual(N.humanize_key("BARBELL_BENCH_PRESS"), "Barbell bench press")
        self.assertEqual(N.humanize_key("3_WAY_CALF_RAISE"), "3 way calf raise")

    def test_serie_dall_endpoint_workouts(self):
        resp = [
            {
                "workoutName": "Forza A",
                "steps": [
                    {"stepIndex": 0, "intensity": "WARMUP", "durationType": "TIME", "durationValue": 300},
                    {
                        "stepIndex": 1,
                        "intensity": "ACTIVE",
                        "durationType": "REPS",
                        "durationValue": 8,
                        "exerciseCategory": "SQUAT",
                        "exerciseName": "BARBELL_BACK_SQUAT",
                        "exerciseWeightValue": 60.0,
                    },
                    {"stepIndex": 2, "intensity": "REST", "durationType": "TIME", "durationValue": 120},
                    {
                        "stepIndex": 3,
                        "intensity": "ACTIVE",
                        "durationType": "TIME",
                        "durationValue": 45,
                        "exerciseCategory": "PLANK",
                    },
                ],
            }
        ]
        sets = N.exercise_sets_from_workouts(resp)
        self.assertEqual(
            sets,
            [
                {"name": "Barbell back squat", "category": "SQUAT", "reps": 8, "kg": 60.0},
                {"name": "Plank", "category": "PLANK", "durationSec": 45},
            ],
        )


if __name__ == "__main__":
    unittest.main()
