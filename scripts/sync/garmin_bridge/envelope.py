"""Busta cifrata del pacchetto di sync (contratto EncryptedEnvelope in src/db/types.ts).

Formato, identico a quello letto da src/lib/garmin/envelope.ts:
    testo  = JSON UTF-8 compatto
    dati   = gzip(testo)                      (mtime=0, nessuna data nell'intestazione)
    chiave = PBKDF2-HMAC-SHA256(password NFC, salt 16 byte, iter, 32 byte)
    ct     = AES-256-GCM(chiave, iv 12 byte, dati)   -> ciphertext con tag GCM (16 byte) in coda
    busta  = {v:1, alg:'AES-256-GCM', kdf:'PBKDF2-SHA256', iter, salt, iv, ct, generatedAt}
             (salt, iv e ct in base64 standard)
"""

from __future__ import annotations

import base64
import binascii
import gzip
import hashlib
import json
import os
import unicodedata
import zlib
from datetime import UTC, datetime
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ENVELOPE_VERSION = 1
ALG = "AES-256-GCM"
KDF = "PBKDF2-SHA256"
DEFAULT_ITERATIONS = 600_000
# Limiti di sicurezza: sotto e' troppo debole, sopra blocca il telefono per minuti.
MIN_ITERATIONS = 1_000
MAX_ITERATIONS = 10_000_000
# Tetto al JSON decompresso: un anno di dati pesa pochi MB, un gzip malevolo di pochi KB si gonfia a GB.
MAX_PLAIN_BYTES = 64 * 1024 * 1024
SALT_BYTES = 16
IV_BYTES = 12
TAG_BYTES = 16


class EnvelopeError(Exception):
    """Errore generico della busta (mai con dati nel messaggio)."""


class WrongPassphraseError(EnvelopeError):
    """Autenticazione GCM fallita: password sbagliata (o dati alterati)."""


class CorruptedEnvelopeError(EnvelopeError):
    """Busta malformata o contenuto illeggibile."""


class UnsupportedVersionError(EnvelopeError):
    """Versione, algoritmo o KDF non supportati."""


def _normalize_passphrase(passphrase: str) -> bytes:
    if not isinstance(passphrase, str) or passphrase == "":
        raise ValueError("password vuota")
    return unicodedata.normalize("NFC", passphrase).encode("utf-8")


def derive_key(passphrase: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", _normalize_passphrase(passphrase), salt, iterations, dklen=32)


def gzip_json(value: Any) -> bytes:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return gzip.compress(text.encode("utf-8"), compresslevel=9, mtime=0)


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def encrypt_json(
    value: Any,
    passphrase: str,
    *,
    iterations: int = DEFAULT_ITERATIONS,
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Cifra un valore JSON e restituisce la busta (dict serializzabile)."""
    if not MIN_ITERATIONS <= iterations <= MAX_ITERATIONS:
        raise ValueError("numero di iterazioni fuori dai limiti")
    salt = os.urandom(SALT_BYTES)
    iv = os.urandom(IV_BYTES)
    key = derive_key(passphrase, salt, iterations)
    ct = AESGCM(key).encrypt(iv, gzip_json(value), None)
    return {
        "v": ENVELOPE_VERSION,
        "alg": ALG,
        "kdf": KDF,
        "iter": iterations,
        "salt": base64.b64encode(salt).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
        "ct": base64.b64encode(ct).decode("ascii"),
        "generatedAt": generated_at or now_iso(),
    }


def _b64(value: Any) -> bytes:
    if not isinstance(value, str):
        raise CorruptedEnvelopeError("campo base64 mancante")
    try:
        return base64.b64decode(value.strip(), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise CorruptedEnvelopeError("base64 non valido") from exc


def parse_envelope(env: Any) -> dict[str, Any]:
    """Valida la struttura della busta (dict o testo JSON) senza decifrarla."""
    if isinstance(env, (str, bytes, bytearray)):
        try:
            env = json.loads(env)
        except (ValueError, UnicodeDecodeError) as exc:
            raise CorruptedEnvelopeError("la busta non e' JSON") from exc
    if not isinstance(env, dict):
        raise CorruptedEnvelopeError("la busta non e' un oggetto")
    version = env.get("v")
    if isinstance(version, bool) or not isinstance(version, int):
        raise CorruptedEnvelopeError("versione mancante")
    if version != ENVELOPE_VERSION:
        raise UnsupportedVersionError("versione della busta non supportata")
    if env.get("alg") != ALG or env.get("kdf") != KDF:
        raise UnsupportedVersionError("algoritmo non supportato")
    iterations = env.get("iter")
    if isinstance(iterations, bool) or not isinstance(iterations, int):
        raise CorruptedEnvelopeError("iterazioni mancanti")
    if not MIN_ITERATIONS <= iterations <= MAX_ITERATIONS:
        raise CorruptedEnvelopeError("iterazioni fuori dai limiti")
    salt, iv, ct = _b64(env.get("salt")), _b64(env.get("iv")), _b64(env.get("ct"))
    if len(salt) < SALT_BYTES or len(iv) != IV_BYTES or len(ct) <= TAG_BYTES:
        raise CorruptedEnvelopeError("lunghezze non valide")
    if not isinstance(env.get("generatedAt"), str):
        raise CorruptedEnvelopeError("generatedAt mancante")
    return {**env, "_salt": salt, "_iv": iv, "_ct": ct}


def gunzip_capped(data: bytes, limit: int = MAX_PLAIN_BYTES) -> bytes:
    """Decomprime un gzip a un solo membro senza superare `limit` byte in memoria."""
    d = zlib.decompressobj(wbits=31)  # 16 + 15: solo intestazione gzip
    out = d.decompress(data, limit + 1)
    if len(out) > limit or d.unconsumed_tail:
        raise CorruptedEnvelopeError("contenuto troppo grande")
    out += d.flush()
    if len(out) > limit:
        raise CorruptedEnvelopeError("contenuto troppo grande")
    if not d.eof or d.unused_data:
        raise CorruptedEnvelopeError("contenuto illeggibile")
    return out


def decrypt_json(env: Any, passphrase: str, max_bytes: int = MAX_PLAIN_BYTES) -> Any:
    """Decifra una busta e restituisce il valore JSON originale."""
    parsed = parse_envelope(env)
    try:
        key = derive_key(passphrase, parsed["_salt"], parsed["iter"])
    except ValueError as exc:
        raise WrongPassphraseError("password vuota") from exc
    try:
        data = AESGCM(key).decrypt(parsed["_iv"], parsed["_ct"], None)
    except InvalidTag as exc:
        raise WrongPassphraseError("password sbagliata o dati alterati") from exc
    try:
        return json.loads(gunzip_capped(data, max_bytes).decode("utf-8"))
    except CorruptedEnvelopeError:
        raise
    except (OSError, EOFError, UnicodeDecodeError, ValueError, zlib.error) as exc:
        raise CorruptedEnvelopeError("contenuto illeggibile") from exc
