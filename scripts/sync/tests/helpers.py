"""Supporto comune ai test: percorsi e piccoli costruttori di dati SINTETICI.

Nessun dato qui viene da un account reale: coordinate, date e valori sono inventati.
"""

from __future__ import annotations

import sys
from pathlib import Path

SYNC_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SYNC_DIR.parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"

if str(SYNC_DIR) not in sys.path:
    sys.path.insert(0, str(SYNC_DIR))

# Password usata SOLO nei test e nella busta di esempio per il test TypeScript.
TEST_PASSPHRASE = "prova-foro-solo-test-2026"
