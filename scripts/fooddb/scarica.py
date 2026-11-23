"""Scarica le fonti del database alimenti (solo libreria standard).

- CIQUAL 2025 (ANSES, Licence Ouverte / Open Licence 2.0 Etalab), DOI 10.57745/RDMHWY.
  Si usa l'endpoint "datafiles" di Recherche Data Gouv, che restituisce uno zip preparato
  dal server: e' piu' affidabile del download diretto (che reindirizza a uno storage S3).
- USDA FoodData Central, SR Legacy 2018-04 (pubblico dominio), solo per i buchi.

I file finiscono in scripts/fooddb/raw/ (ignorata da git) e sono verificati con MD5.

Uso:  python scripts/fooddb/scarica.py
"""
from __future__ import annotations

import hashlib
import io
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

QUI = Path(__file__).resolve().parent
RAW = QUI / 'raw'

CIQUAL = {
    'versione': 'Ciqual 2025',
    'doi': '10.57745/RDMHWY',
    # id dei file nel dataset: xlsx, alim.xml, alim_grp.xml
    'zip_url': 'https://entrepot.recherche.data.gouv.fr/api/access/datafiles/666260,666252,666250',
    'file_url': 'https://entrepot.recherche.data.gouv.fr/api/access/datafile/{id}',
    'files': {
        'Table Ciqual 2025_FR_2025_11_03.xlsx': (666260, '0d9758ce23f3f13dd63a005bc1bb4f2c'),
        'alim_2025_11_03.xml': (666252, '8e1171d63cee4b6010cfce25dd29243d'),
        'alim_grp_2025_11_03.xml': (666250, 'c31aeea90349c3aab86f98ef5f4f10da'),
    },
}

USDA = {
    'versione': 'USDA FoodData Central SR Legacy 2018-04',
    'url': 'https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip',
    'file': 'FoodData_Central_sr_legacy_food_csv_2018-04.zip',
    # MD5 del file scaricato il 2026-11-23 (6.074.592 byte); SR Legacy e' congelato dal 2018
    'md5': 'b35951cc9dae0e0d9d1dce93c4532442',
}

UA = 'Foro-fooddb/1.0 (build del database alimenti; https://github.com)'


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def http_get(url: str, tentativi: int = 3, timeout: int = 300) -> bytes:
    ultimo: Exception | None = None
    for i in range(tentativi):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # rete instabile: riprova con attesa crescente
            ultimo = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f'download fallito: {url}: {ultimo}')


def scarica_ciqual() -> Path:
    dest = RAW / 'ciqual2025'
    dest.mkdir(parents=True, exist_ok=True)
    mancanti = [n for n, (_, h) in CIQUAL['files'].items()
                if not (dest / n).exists() or md5((dest / n).read_bytes()) != h]
    if not mancanti:
        print('CIQUAL 2025: file gia presenti e verificati')
        return dest
    print('CIQUAL 2025: scarico lo zip preparato dal server...')
    try:
        z = zipfile.ZipFile(io.BytesIO(http_get(CIQUAL['zip_url'])))
        for info in z.infolist():
            if info.filename in CIQUAL['files']:
                (dest / info.filename).write_bytes(z.read(info.filename))
    except Exception as e:
        print(f'  zip non disponibile ({e}); provo i singoli file')
        for nome, (fid, _) in CIQUAL['files'].items():
            (dest / nome).write_bytes(http_get(CIQUAL['file_url'].format(id=fid)))
    for nome, (_, atteso) in CIQUAL['files'].items():
        got = md5((dest / nome).read_bytes())
        if got != atteso:
            raise SystemExit(f'MD5 errato per {nome}: {got} invece di {atteso}')
        print(f'  ok {nome} ({atteso})')
    return dest


def scarica_usda() -> Path:
    dest = RAW / 'usda'
    dest.mkdir(parents=True, exist_ok=True)
    f = dest / USDA['file']
    if not f.exists():
        print('USDA SR Legacy: scarico...')
        f.write_bytes(http_get(USDA['url']))
    data = f.read_bytes()
    got = md5(data)
    if got != USDA['md5']:
        f.unlink()
        raise SystemExit(f'MD5 errato per {USDA["file"]}: {got} invece di {USDA["md5"]}; rilancia lo script')
    print(f'  ok {USDA["file"]} ({got})')
    return dest


def main() -> None:
    scarica_ciqual()
    scarica_usda()


if __name__ == '__main__':
    sys.exit(main())
