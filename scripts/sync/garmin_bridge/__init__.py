"""Ponte Garmin -> app Foro: sync dalla Garmin Connect Personal API ufficiale.

Moduli:
- envelope: busta cifrata (gzip + AES-256-GCM + PBKDF2-SHA256), compatibile con src/lib/garmin/envelope.ts
- geo: taglio privacy, semplificazione Douglas-Peucker, sottocampionamento delle serie
- normalize: dalle risposte JSON di Garmin al contratto SyncBundle (src/db/types.ts)
- fitparse: dettagli dai file FIT (giri, traccia, serie FC/passo, serie di forza)
- api: accesso all'API tramite il client Python ufficiale di Garmin
- sync: sync incrementale, unione col pacchetto precedente e potatura delle finestre
"""

__all__ = ["envelope", "geo", "normalize", "fitparse", "api", "sync"]
