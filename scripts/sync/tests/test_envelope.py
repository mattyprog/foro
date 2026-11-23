"""Busta cifrata: gzip(JSON) -> AES-256-GCM con chiave PBKDF2-SHA256."""

from __future__ import annotations

import base64
import json
import unittest

import helpers  # noqa: F401  (imposta sys.path)
from helpers import TEST_PASSPHRASE

from garmin_bridge import envelope
from garmin_bridge.envelope import (
    CorruptedEnvelopeError,
    UnsupportedVersionError,
    WrongPassphraseError,
    decrypt_json,
    encrypt_json,
)

SAMPLE = {"version": 1, "nome": "Corsa all'alba è bella", "numeri": [1, 2.5, None]}


class EnvelopeTest(unittest.TestCase):
    def test_round_trip_con_parametri_predefiniti(self):
        env = encrypt_json(SAMPLE, TEST_PASSPHRASE, generated_at="2026-11-20T09:23:00Z")
        self.assertEqual(env["v"], 1)
        self.assertEqual(env["alg"], "AES-256-GCM")
        self.assertEqual(env["kdf"], "PBKDF2-SHA256")
        self.assertEqual(env["iter"], 600_000)
        self.assertEqual(env["generatedAt"], "2026-11-20T09:23:00Z")
        self.assertEqual(len(base64.b64decode(env["salt"])), 16)
        self.assertEqual(len(base64.b64decode(env["iv"])), 12)
        self.assertEqual(decrypt_json(env, TEST_PASSPHRASE), SAMPLE)

    def test_sale_e_iv_cambiano_a_ogni_cifratura(self):
        a = encrypt_json(SAMPLE, TEST_PASSPHRASE, iterations=1000)
        b = encrypt_json(SAMPLE, TEST_PASSPHRASE, iterations=1000)
        self.assertNotEqual(a["salt"], b["salt"])
        self.assertNotEqual(a["iv"], b["iv"])
        self.assertNotEqual(a["ct"], b["ct"])

    def test_il_testo_in_chiaro_non_compare_nella_busta(self):
        env = encrypt_json(SAMPLE, TEST_PASSPHRASE, iterations=1000)
        text = json.dumps(env)
        self.assertNotIn("Corsa", text)
        self.assertNotIn("alba", text)

    def test_password_sbagliata(self):
        env = encrypt_json(SAMPLE, TEST_PASSPHRASE, iterations=1000)
        with self.assertRaises(WrongPassphraseError):
            decrypt_json(env, "un'altra password qualsiasi")

    def test_password_normalizzata_nfc(self):
        # "è" composta (U+00E8) e scomposta (e + U+0300) devono dare la stessa chiave.
        composed = "caff\u00e8-lungo-mattina"
        decomposed = "caffe\u0300-lungo-mattina"
        env = encrypt_json(SAMPLE, composed, iterations=1000)
        self.assertEqual(decrypt_json(env, decomposed), SAMPLE)

    def test_ciphertext_alterato(self):
        env = encrypt_json(SAMPLE, TEST_PASSPHRASE, iterations=1000)
        raw = bytearray(base64.b64decode(env["ct"]))
        raw[3] ^= 0x01
        env["ct"] = base64.b64encode(bytes(raw)).decode()
        # GCM non distingue tra chiave errata e dati alterati: entrambi falliscono l'autenticazione.
        with self.assertRaises(WrongPassphraseError):
            decrypt_json(env, TEST_PASSPHRASE)

    def test_busta_malformata(self):
        env = encrypt_json(SAMPLE, TEST_PASSPHRASE, iterations=1000)
        for broken in (
            "non sono json",
            {**env, "iv": base64.b64encode(b"corto").decode()},
            {**env, "salt": "%%%"},
            {**env, "ct": base64.b64encode(b"x" * 8).decode()},
            {**env, "iter": 10},
            {k: v for k, v in env.items() if k != "ct"},
        ):
            with self.subTest(broken=str(broken)[:40]):
                with self.assertRaises(CorruptedEnvelopeError):
                    decrypt_json(broken, TEST_PASSPHRASE)

    def test_versione_non_supportata(self):
        env = encrypt_json(SAMPLE, TEST_PASSPHRASE, iterations=1000)
        with self.assertRaises(UnsupportedVersionError):
            decrypt_json({**env, "v": 2}, TEST_PASSPHRASE)
        with self.assertRaises(UnsupportedVersionError):
            decrypt_json({**env, "alg": "AES-128-CBC"}, TEST_PASSPHRASE)

    def test_accetta_la_busta_come_testo_json(self):
        env = encrypt_json(SAMPLE, TEST_PASSPHRASE, iterations=1000)
        self.assertEqual(decrypt_json(json.dumps(env), TEST_PASSPHRASE), SAMPLE)

    def test_password_vuota_rifiutata(self):
        with self.assertRaises(ValueError):
            encrypt_json(SAMPLE, "", iterations=1000)

    def test_gzip_senza_timestamp(self):
        # mtime=0: lo stesso contenuto produce lo stesso gzip (nessuna data nell'intestazione).
        self.assertEqual(envelope.gzip_json(SAMPLE), envelope.gzip_json(SAMPLE))


    def test_tetto_alla_decompressione(self):
        grande = {"version": 1, "riempitivo": "a" * 300_000}  # si comprime a pochi KB
        env = encrypt_json(grande, TEST_PASSPHRASE, iterations=1000)
        self.assertLess(len(json.dumps(env)), 20_000)
        with self.assertRaisesRegex(CorruptedEnvelopeError, "troppo grande"):
            decrypt_json(env, TEST_PASSPHRASE, max_bytes=100_000)
        self.assertEqual(decrypt_json(env, TEST_PASSPHRASE, max_bytes=400_000), grande)

    def test_gzip_troncato_o_con_coda(self):
        import gzip as _gz

        buono = _gz.compress(b'{"a": 1}', mtime=0)
        with self.assertRaises(CorruptedEnvelopeError):
            envelope.gunzip_capped(buono[:-6])
        with self.assertRaises(CorruptedEnvelopeError):
            envelope.gunzip_capped(buono + b"coda")
        self.assertEqual(envelope.gunzip_capped(buono), b'{"a": 1}')

if __name__ == "__main__":
    unittest.main()
