#!/usr/bin/env python3
"""Sync Garmin -> Foro: scarica i dati dalla Garmin Connect Personal API e li pubblica CIFRATI.

Uso (dalla radice del repository):
    python scripts/sync/garmin_sync.py --out scripts/sync/out [--previous vecchio/garmin.json.enc]
        [--activity-days 365] [--fit-days 90] [--wellness-days 90] [--full] [--plain data-local/bundle.json]

Variabili d'ambiente:
    GARMIN_PERSONAL_API_KEY  chiave personale creata su Garmin Connect (obbligatoria)
    SYNC_PASSPHRASE          password della busta, la stessa da inserire nell'app (obbligatoria, >= 12 caratteri)
    PRIVACY_TRIM_M           metri tagliati a inizio e fine di ogni traccia GPS (predefinito 300)
    SYNC_TZ                  fuso per "oggi" e per gli orari senza offset (predefinito Europe/Rome)

Scrive <out>/garmin.json.enc (busta EncryptedEnvelope) e <out>/meta.json ({v, generatedAt}).
I log contengono solo conteggi e avvisi generici: mai valori, date, nomi o identificativi.

Codici di uscita: 0 ok (anche con avvisi, secret mancanti o Garmin momentaneamente giu');
2 autenticazione rifiutata; 3 cifratura o scrittura non riuscite (o password troppo corta);
1 errore imprevisto.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TextIO
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from garmin_bridge.api import AuthError, GarminApi, GarminUnavailableError
from garmin_bridge.envelope import EnvelopeError, decrypt_json, encrypt_json
from garmin_bridge.sync import SyncOptions, run_sync

EXIT_OK = 0
EXIT_UNEXPECTED = 1
EXIT_AUTH = 2
EXIT_CRYPTO = 3
MIN_PASSPHRASE = 12
ENVELOPE_NAME = "garmin.json.enc"
META_NAME = "meta.json"


def _days(value: str) -> int:
    n = int(value)
    if not 1 <= n <= 3650:
        raise argparse.ArgumentTypeError("giorni fuori dall'intervallo 1-3650")
    return n


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sync Garmin Connect Personal API -> pacchetto cifrato per Foro")
    p.add_argument("--out", required=True, help="cartella di uscita (garmin.json.enc e meta.json)")
    p.add_argument("--previous", help="busta della sync precedente, per scaricare solo il nuovo")
    p.add_argument("--activity-days", type=_days, default=365, help="giorni di riepiloghi attivita' (365)")
    p.add_argument("--fit-days", type=_days, default=90, help="giorni con dettagli dai file FIT (90)")
    p.add_argument("--wellness-days", type=_days, default=90, help="giorni di dati di benessere (90)")
    p.add_argument("--full", action="store_true", help="ignora i cursori e riscarica tutto (FIT compresi)")
    p.add_argument("--plain", help="SOLO in locale: scrive anche il pacchetto in chiaro (percorso gitignored)")
    return p.parse_args(argv)


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _is_inside(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def main(
    argv: list[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    session: Any = None,
    now: datetime | None = None,
    stdout: TextIO | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    env = os.environ if env is None else env
    out = stdout or sys.stdout

    def say(line: str = "") -> None:
        print(line, file=out, flush=True)

    args = parse_args(argv)
    api_key = (env.get("GARMIN_PERSONAL_API_KEY") or "").strip()
    passphrase = env.get("SYNC_PASSPHRASE") or ""
    if not api_key or not passphrase:
        say(
            "Garmin sync: secret mancanti (GARMIN_PERSONAL_API_KEY e SYNC_PASSPHRASE). "
            "Aggiungili in Settings > Secrets and variables > Actions, vedi docs/GARMIN.md. Nessun dato scaricato."
        )
        return EXIT_OK
    if len(passphrase) < MIN_PASSPHRASE:
        say(f"Garmin sync: SYNC_PASSPHRASE troppo corta (minimo {MIN_PASSPHRASE} caratteri, meglio 4 o 5 parole). Nessun dato scaricato.")
        return EXIT_CRYPTO

    try:
        trim = float(env.get("PRIVACY_TRIM_M") or 300)
        if trim < 0 or trim > 5000:
            raise ValueError
    except ValueError:
        say("Garmin sync: PRIVACY_TRIM_M non valido, uso 300 m.")
        trim = 300.0
    try:
        tz = ZoneInfo(env.get("SYNC_TZ") or "Europe/Rome")
    except (ZoneInfoNotFoundError, ValueError):
        say("Garmin sync: SYNC_TZ non valido, uso Europe/Rome.")
        tz = ZoneInfo("Europe/Rome")

    now = now or datetime.now(UTC)
    today = now.astimezone(tz).date()
    out_dir = Path(args.out)
    extra_warnings: list[str] = []

    previous = None
    if args.previous:
        prev_path = Path(args.previous)
        if prev_path.is_file() and prev_path.stat().st_size > 0:
            try:
                previous = decrypt_json(prev_path.read_text(encoding="utf-8"), passphrase)
            except (EnvelopeError, OSError, UnicodeDecodeError):
                extra_warnings.append("Pacchetto precedente non leggibile con la password attuale: risincronizzazione completa.")
    # con --full il pacchetto precedente resta solo come base per i gruppi che dovessero fallire
    mode = "incrementale" if previous is not None and not args.full else "completa"
    say(f"Garmin sync: modalità {mode}.")

    opts = SyncOptions(
        activity_days=args.activity_days,
        fit_days=args.fit_days,
        wellness_days=args.wellness_days,
        privacy_trim_m=trim,
        full=args.full,
        tz=tz,
    )
    try:
        with GarminApi(api_key, session=session, sleep=sleep, polite_delay=0 if session is not None else 0.2) as api:
            try:
                api.connect()
            except AuthError as exc:
                say(
                    f"Garmin sync: chiave rifiutata da Garmin{f' (HTTP {exc.status})' if exc.status else ''}. "
                    "Probabilmente è scaduta o è stata revocata: creane una nuova e aggiorna il secret (docs/GARMIN.md)."
                )
                return EXIT_AUTH
            except GarminUnavailableError as exc:
                say(
                    f"Garmin sync: Garmin non raggiungibile ora{f' (HTTP {exc.status})' if exc.status else ''}. "
                    "Riprovo al prossimo giro; resta pubblicato il pacchetto precedente."
                )
                return EXIT_OK
            try:
                bundle, stats = run_sync(api, previous, opts, today=today, now=now)
            except AuthError as exc:
                say(f"Garmin sync: autorizzazione persa durante la sync{f' (HTTP {exc.status})' if exc.status else ''}. Nessun dato pubblicato.")
                return EXIT_AUTH
    except Exception as exc:  # noqa: BLE001 - mai stampare il messaggio: potrebbe contenere dati
        say(f"Garmin sync: errore imprevisto ({type(exc).__name__}). Nessun dato pubblicato.")
        return EXIT_UNEXPECTED

    bundle["warnings"] = extra_warnings + bundle["warnings"]
    try:
        envelope = encrypt_json(bundle, passphrase, generated_at=bundle["generatedAt"])
        _write_atomic(out_dir / ENVELOPE_NAME, json.dumps(envelope, separators=(",", ":")))
        _write_atomic(out_dir / META_NAME, json.dumps({"v": 1, "generatedAt": bundle["generatedAt"]}))
    except Exception as exc:  # noqa: BLE001
        say(f"Garmin sync: cifratura o scrittura del pacchetto non riuscita ({type(exc).__name__}).")
        return EXIT_CRYPTO

    if args.plain:
        plain = Path(args.plain)
        if env.get("GITHUB_ACTIONS") == "true" or env.get("CI") == "true":
            say("Garmin sync: --plain ignorato (in CI non si scrivono dati in chiaro).")
        elif _is_inside(plain, out_dir):
            say("Garmin sync: --plain ignorato (non puo' stare nella cartella pubblicata).")
        else:
            _write_atomic(plain, json.dumps(bundle, ensure_ascii=False, indent=1))
            say("Garmin sync: pacchetto in chiaro scritto (solo per debug locale, non committarlo).")

    s = stats
    warnings = bundle["warnings"]
    say("Garmin sync completata.")
    say(f"  attività: {s.activities} (nuove {s.activities_new}, aggiornate {s.activities_updated}, rimosse {s.activities_removed})")
    say(f"  file FIT: elaborati {s.fit_parsed}, senza file {s.fit_unavailable}, illeggibili {s.fit_unreadable}, da riprovare {s.fit_retry}")
    say(f"  benessere: {s.wellness_days} giorni")
    say(f"  pesi: {s.weights}")
    say(f"  richieste a Garmin: {s.requests}")
    say(f"  avvisi: {len(warnings)}")
    for w in warnings:  # testi generici, senza dati
        say(f"  - {w}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
