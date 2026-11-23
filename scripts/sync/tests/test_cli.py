"""Riga di comando: secret mancanti, codici di uscita, file prodotti, log senza dati."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

import helpers  # noqa: F401
from fake_garmin import FAKE_API_KEY, FakeGarmin
from helpers import TEST_PASSPHRASE

import garmin_sync
from garmin_bridge.envelope import decrypt_json, encrypt_json

NOW = datetime(2026, 11, 20, 9, 23, tzinfo=UTC)
ENV = {"GARMIN_PERSONAL_API_KEY": FAKE_API_KEY, "SYNC_PASSPHRASE": TEST_PASSPHRASE}


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="foro-cli-test-"))
        self.out = self.tmp / "out"

    def tearDown(self):
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, args, env=ENV, fake=None):
        stdout = io.StringIO()
        fake = fake or FakeGarmin()
        code = garmin_sync.main(args, env=env, session=fake, now=NOW, stdout=stdout, sleep=lambda _s: None)
        return code, stdout.getvalue(), fake

    def test_secret_mancanti_exit_0_senza_file(self):
        for env in ({}, {"GARMIN_PERSONAL_API_KEY": FAKE_API_KEY}, {"SYNC_PASSPHRASE": TEST_PASSPHRASE}):
            with self.subTest(env=list(env)):
                code, text, fake = self.run_cli(["--out", str(self.out)], env=env)
                self.assertEqual(code, 0)
                self.assertIn("mancanti", text)
                self.assertFalse(self.out.exists())
                self.assertEqual(fake.calls, [])

    def test_password_troppo_corta(self):
        code, text, fake = self.run_cli(["--out", str(self.out)], env={**ENV, "SYNC_PASSPHRASE": "corta"})
        self.assertEqual(code, 3)
        self.assertFalse(self.out.exists())
        self.assertEqual(fake.calls, [])

    def test_sync_completa_scrive_busta_e_meta(self):
        code, text, _ = self.run_cli(["--out", str(self.out)])
        self.assertEqual(code, 0, text)
        env = json.loads((self.out / "garmin.json.enc").read_text(encoding="utf-8"))
        meta = json.loads((self.out / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(meta, {"v": 1, "generatedAt": "2026-11-20T09:23:00Z"})
        self.assertEqual(env["generatedAt"], meta["generatedAt"])
        self.assertEqual(env["iter"], 600_000)
        bundle = decrypt_json(env, TEST_PASSPHRASE)
        self.assertEqual(len(bundle["activities"]), 7)
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["garmin.json.enc", "meta.json"])

    def test_log_solo_conteggi(self):
        code, text, fake = self.run_cli(["--out", str(self.out)])
        self.assertEqual(code, 0)
        self.assertIn("attività: 7", text)
        for forbidden in ("Corsa facile", "9000000", "2026-11", "Olathe", FAKE_API_KEY, TEST_PASSPHRASE, "Bearer"):
            self.assertNotIn(forbidden, text)
        raw = (self.out / "garmin.json.enc").read_text(encoding="utf-8")
        for forbidden in ("Corsa facile", "9000000", "activities"):
            self.assertNotIn(forbidden, raw)

    def test_incrementale_con_previous(self):
        self.run_cli(["--out", str(self.out)])
        prev = self.tmp / "prev.enc"
        prev.write_bytes((self.out / "garmin.json.enc").read_bytes())
        fake = FakeGarmin()
        code, text, fake = self.run_cli(["--out", str(self.out), "--previous", str(prev)], fake=fake)
        self.assertEqual(code, 0, text)
        self.assertIn("incrementale", text)
        self.assertEqual(fake.calls_to("/download-service"), [])

    def test_previous_con_password_diversa_risincronizza(self):
        prev = self.tmp / "prev.enc"
        prev.write_text(json.dumps(encrypt_json({"version": 1}, "un'altra password lunga", iterations=1000)), encoding="utf-8")
        code, text, fake = self.run_cli(["--out", str(self.out), "--previous", str(prev)])
        self.assertEqual(code, 0)
        self.assertIn("completa", text)
        bundle = decrypt_json((self.out / "garmin.json.enc").read_text(encoding="utf-8"), TEST_PASSPHRASE)
        self.assertTrue(any("precedente" in w for w in bundle["warnings"]))
        self.assertEqual(len(fake.calls_to("/download-service")), 5)

    def test_previous_assente_o_vuoto(self):
        empty = self.tmp / "vuoto.enc"
        empty.write_bytes(b"")
        for path in (self.tmp / "non-esiste.enc", empty):
            with self.subTest(path=path.name):
                code, _, _ = self.run_cli(["--out", str(self.out), "--previous", str(path)])
                self.assertEqual(code, 0)

    def test_chiave_rifiutata_exit_2(self):
        code, text, _ = self.run_cli(["--out", str(self.out)], env={**ENV, "GARMIN_PERSONAL_API_KEY": "sbagliata"})
        self.assertEqual(code, 2)
        self.assertIn("chiave", text.lower())
        self.assertFalse((self.out / "garmin.json.enc").exists())

    def test_garmin_irraggiungibile_exit_0_senza_pubblicare(self):
        fake = FakeGarmin()
        fake.token_status = 503
        code, text, _ = self.run_cli(["--out", str(self.out)], fake=fake)
        self.assertEqual(code, 0)
        self.assertFalse((self.out / "garmin.json.enc").exists())

    def test_plain_solo_in_locale(self):
        plain = self.tmp / "data-local" / "bundle.json"
        code, _, _ = self.run_cli(["--out", str(self.out), "--plain", str(plain)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(plain.read_text(encoding="utf-8"))["version"], 1)
        plain.unlink()
        code, text, _ = self.run_cli(["--out", str(self.out), "--plain", str(plain)], env={**ENV, "GITHUB_ACTIONS": "true"})
        self.assertEqual(code, 0)
        self.assertFalse(plain.exists())
        self.assertIn("ignorato", text)
        code, _, _ = self.run_cli(["--out", str(self.out), "--plain", str(self.out / "chiaro.json")])
        self.assertFalse((self.out / "chiaro.json").exists())

    def test_opzioni_delle_finestre(self):
        code, _, fake = self.run_cli(["--out", str(self.out), "--activity-days", "30", "--fit-days", "3", "--wellness-days", "7"])
        self.assertEqual(code, 0)
        bundle = decrypt_json((self.out / "garmin.json.enc").read_text(encoding="utf-8"), TEST_PASSPHRASE)
        self.assertEqual(bundle["range"], {"from": "2026-10-21", "to": "2026-11-20"})
        self.assertEqual(len(bundle["wellness"]), 8)
        self.assertEqual(len(fake.calls_to("/download-service")), 2)

    def test_taglio_privacy_configurabile(self):
        code, _, _ = self.run_cli(["--out", str(self.out)], env={**ENV, "PRIVACY_TRIM_M": "800"})
        self.assertEqual(code, 0)
        bundle = decrypt_json((self.out / "garmin.json.enc").read_text(encoding="utf-8"), TEST_PASSPHRASE)
        run = next(a for a in bundle["activities"] if a["id"] == "garmin:9000000101")
        # 3 km con 800 m tagliati per parte: resta il tratto centrale, lontano almeno 800 m dalla partenza
        from synthetic_fit import START_LAT, START_LON

        from garmin_bridge.geo import haversine_m

        self.assertTrue(all(haversine_m(START_LAT, START_LON, lat, lon) >= 799 for lat, lon in run["track"]))


if __name__ == "__main__":
    unittest.main()
