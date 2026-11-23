"""Accesso all'API tramite il client ufficiale: token, rinnovo, ritentativi, errori senza dati."""

from __future__ import annotations

import unittest

import helpers  # noqa: F401
from fake_garmin import FAKE_API_KEY, FakeGarmin

from garmin_bridge.api import AuthError, EndpointError, GarminApi, GarminUnavailableError


def make_api(test: unittest.TestCase, fake: FakeGarmin, key: str = FAKE_API_KEY) -> GarminApi:
    api = GarminApi(key, session=fake, sleep=lambda _s: None, polite_delay=0)
    test.addCleanup(api.close)
    return api


class ApiTest(unittest.TestCase):
    def test_token_e_chiamata_autenticata(self):
        fake = FakeGarmin()
        api = make_api(self, fake)
        api.connect()
        data = api.get_json("/hrv-service/hrv/daily/2026-11-18/2026-11-19")
        self.assertEqual(len(data["hrvSummaries"]), 2)
        self.assertEqual(fake.tokens_issued, 1)
        api.close()

    def test_chiave_rifiutata(self):
        fake = FakeGarmin()
        api = make_api(self, fake, key="chiave-sbagliata")
        with self.assertRaises(AuthError):
            api.connect()

    def test_garmin_irraggiungibile_al_token(self):
        fake = FakeGarmin()
        fake.token_status = 503
        with self.assertRaises(GarminUnavailableError):
            make_api(self, fake).connect()

    def test_token_scaduto_viene_rinnovato_una_volta(self):
        fake = FakeGarmin()
        api = make_api(self, fake)
        api.connect()
        fake.expire_tokens()
        data = api.get_json("/fitnessage-service/fitnessage/v2/2026-11-20")
        self.assertEqual(data[0]["fitnessAge"], 27.43)
        self.assertEqual(fake.tokens_issued, 2)

    def test_errore_temporaneo_ritentato(self):
        fake = FakeGarmin()
        fake.fail_once["/fitnessage-service"] = [503, 429]
        api = make_api(self, fake)
        api.connect()
        self.assertTrue(api.get_json("/fitnessage-service/fitnessage/v2/2026-11-20"))
        self.assertEqual(len(fake.calls_to("/fitnessage-service")), 3)

    def test_errore_permanente_senza_dati_nel_messaggio(self):
        fake = FakeGarmin()
        api = make_api(self, fake)
        api.connect()
        with self.assertRaises(EndpointError) as ctx:
            api.download_activity("9000000104")  # la camminata non ha file: 404
        self.assertTrue(ctx.exception.permanent)
        self.assertEqual(ctx.exception.status, 404)
        self.assertNotIn("9000000104", str(ctx.exception))
        self.assertIsNone(ctx.exception.__cause__)
        self.assertTrue(ctx.exception.__suppress_context__)

    def test_download_del_file_originale(self):
        fake = FakeGarmin()
        api = make_api(self, fake)
        api.connect()
        self.assertEqual(api.download_activity("9000000101")[:2], b"PK")

    def test_la_cache_del_token_sparisce_alla_chiusura(self):
        fake = FakeGarmin()
        api = make_api(self, fake)
        api.connect()
        cache = api.token_cache_path
        self.assertTrue(cache.exists())
        api.close()
        self.assertFalse(cache.exists())


if __name__ == "__main__":
    unittest.main()
