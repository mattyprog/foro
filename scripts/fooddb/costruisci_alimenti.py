"""Costruisce src/data/alimenti.json da CIQUAL 2025 (piu' USDA per i buchi) e selezione.csv.

Formato di selezione.csv (separatore ';', UTF-8, una riga per alimento):
  codice     codice CIQUAL (es. 20052) oppure 'usda:<fdc_id>' (es. usda:170381)
  nome       nome italiano mostrato nell'app (da qui si ricava l'id)
  alias      sinonimi per la ricerca, separati da '|'
  categoria  categoria italiana (vedi CATEGORIE)
  porzioni   'etichetta=grammi' separate da '|' (vuoto = porzione di default della categoria)
  senza      nutrienti da NON riportare perche' la fonte non rappresenta bene l'alimento (es. salt)
  nota       ipotesi o approssimazioni (ultima colonna: puo' contenere ';')

Regole sui valori (documentate in docs/ALIMENTI.md):
  - '-' o cella vuota: dato mancante (undefined nel JSON, mai 0);
  - 'traces' e '< x': 0. E' la regola con cui ANSES calcola l'energia: con questa scelta
    kcal e macronutrienti restano coerenti (controllo di Atwater sotto).
  - Energia: colonna 'Energie, Reglement UE N 1169/2011 (kcal/100 g)'. Se manca, si calcola
    con i fattori UE (4 proteine, 4 carboidrati disponibili, 9 grassi, 2 fibre, 7 alcol,
    2,4 polioli, 3 acidi organici).
  - Proteine: N x 6,25 (definizione del Regolamento UE 1169/2011).
  - USDA: carboidrati disponibili = carboidrati per differenza - fibre; energia ricalcolata
    con i fattori UE; sale = sodio x 2,5.

Uso:  python scripts/fooddb/costruisci_alimenti.py   (scarica le fonti se mancano)
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import unicodedata
import zipfile
from pathlib import Path

QUI = Path(__file__).resolve().parent
sys.path.insert(0, str(QUI))

import scarica  # noqa: E402
from xlsx import read_rows  # noqa: E402

ROOT = QUI.parent.parent
OUT = ROOT / 'src' / 'data' / 'alimenti.json'
SELEZIONE = QUI / 'selezione.csv'

CATEGORIE = {
    # categoria: porzioni di default (se la riga non ne indica)
    'Verdura': [('porzione', 200)],
    'Frutta': [('porzione', 150)],
    'Frutta secca e semi': [('1 manciata', 30)],
    'Legumi': [('porzione', 150)],
    'Patate e tuberi': [('porzione', 200)],
    'Pasta, riso e cereali': [('porzione', 80)],
    'Pane e lievitati': [('porzione', 50)],
    'Carne': [('porzione', 100)],
    'Salumi': [('porzione', 50)],
    'Pesce': [('porzione', 150)],
    'Uova': [('1 uovo medio', 55)],
    'Latte e yogurt': [('1 bicchiere', 200)],
    'Formaggi': [('porzione', 50)],
    'Oli e grassi': [('1 cucchiaio', 10)],
    'Condimenti e salse': [('1 cucchiaio', 15)],
    'Erbe e spezie': [('1 cucchiaino', 2)],
    'Dolci': [('porzione', 50)],
    'Colazione': [('porzione', 30)],
    'Snack salati': [('porzione', 30)],
    'Bevande': [('1 bicchiere', 200)],
    'Bevande alcoliche': [('1 bicchiere', 125)],
    'Integratori': [('1 misurino', 30)],
    'Proteine vegetali': [('porzione', 100)],
    'Piatti pronti': [('porzione', 250)],
}

NUTRIENTI = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'satFat', 'salt',
             'alcohol', 'polyols', 'organicAcids']
# opzionali tenuti nel JSON solo se > 0 (servono al controllo di Atwater)
SOLO_SE_POSITIVI = {'alcohol', 'polyols', 'organicAcids'}

# riconoscimento delle colonne CIQUAL dall'intestazione normalizzata
COLONNE_CIQUAL = {
    'code': lambda h: h == 'alim_code',
    'nome_fr': lambda h: h == 'alim_nom_fr',
    'kcal': lambda h: h.startswith('energie, reglement ue') and '(kcal' in h,
    'protein': lambda h: h.startswith('proteines, n x 6.25'),
    'carbs': lambda h: h.startswith('glucides'),
    'fat': lambda h: h.startswith('lipides'),
    'sugars': lambda h: h.startswith('sucres'),
    'fiber': lambda h: h.startswith('fibres alimentaires'),
    'polyols': lambda h: h.startswith('polyols totaux'),
    'alcohol': lambda h: h.startswith('alcool'),
    'organicAcids': lambda h: h.startswith('acides organiques'),
    'satFat': lambda h: h.startswith('ag satures'),
    'salt': lambda h: h.startswith('sel chlorure de sodium'),
}

USDA_NUTRIENTI = {  # id nutriente FDC -> chiave
    '1003': 'protein', '1004': 'fat', '1005': 'carbs_diff', '1079': 'fiber',
    '2000': 'sugars', '1258': 'satFat', '1093': 'sodium_mg', '1018': 'alcohol',
}


def senza_accenti(s: str) -> str:
    return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')


def norm_header(h: str) -> str:
    return re.sub(r'\s+', ' ', senza_accenti(h)).strip().lower()


def slug(s: str) -> str:
    s = senza_accenti(s).lower().replace("'", ' ')
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def valore_ciqual(s: str) -> float | None:
    s = (s or '').strip()
    if s in ('', '-'):
        return None
    low = s.lower()
    if low.startswith('traces') or s.startswith('<'):
        return 0.0
    return float(s.replace(',', '.'))


def energia_ue(n: dict) -> float:
    g = lambda k: n.get(k) or 0.0  # noqa: E731
    disp = g('carbs') - g('polyols')
    return (4 * g('protein') + 4 * disp + 2.4 * g('polyols') + 9 * g('fat')
            + 2 * g('fiber') + 7 * g('alcohol') + 3 * g('organicAcids'))


def arrotonda(n: dict) -> dict:
    out = {}
    for k in NUTRIENTI:
        v = n.get(k)
        if v is None:
            continue
        if k in SOLO_SE_POSITIVI and v <= 0:
            continue
        out[k] = round(v, 1) if k == 'kcal' else round(v, 3)
    return out


def leggi_selezione() -> list[dict]:
    righe = []
    with SELEZIONE.open(encoding='utf-8') as f:
        intestazione = f.readline().strip().split(';')
        assert intestazione == ['codice', 'nome', 'alias', 'categoria', 'porzioni', 'senza', 'nota'], intestazione
        for i, riga in enumerate(f, start=2):
            riga = riga.rstrip('\n')
            if not riga.strip():
                continue
            campi = riga.split(';', 6)
            if len(campi) != 7:
                raise SystemExit(f'selezione.csv riga {i}: attese 7 colonne, trovate {len(campi)}')
            codice, nome, alias, categoria, porzioni, senza, nota = (c.strip() for c in campi)
            if categoria not in CATEGORIE:
                raise SystemExit(f'selezione.csv riga {i}: categoria sconosciuta {categoria!r}')
            porz = []
            for p in filter(None, porzioni.split('|')):
                etichetta, _, grammi = p.rpartition('=')
                g = float(grammi)
                if not etichetta or g <= 0:
                    raise SystemExit(f'selezione.csv riga {i}: porzione non valida {p!r}')
                porz.append({'label': etichetta.strip(), 'grams': int(g) if g.is_integer() else g})
            if not porz:
                porz = [{'label': l, 'grams': g} for l, g in CATEGORIE[categoria]]
            righe.append({
                'riga': i, 'codice': codice, 'nome': nome,
                'alias': [a.strip() for a in alias.split('|') if a.strip()],
                'categoria': categoria, 'porzioni': porz,
                'senza': [s.strip() for s in senza.split('|') if s.strip()],
                'nota': nota,
            })
    return righe


def leggi_ciqual(cartella: Path) -> dict[str, dict]:
    xlsx = cartella / 'Table Ciqual 2025_FR_2025_11_03.xlsx'
    righe = read_rows(str(xlsx))
    intest = [norm_header(h) for h in righe[0]]
    idx = {}
    for chiave, test in COLONNE_CIQUAL.items():
        trovate = [i for i, h in enumerate(intest) if test(h)]
        if len(trovate) != 1:
            raise SystemExit(f'colonna CIQUAL {chiave}: trovate {len(trovate)} corrispondenze')
        idx[chiave] = trovate[0]
    dati = {}
    for r in righe[1:]:
        if not r:
            continue
        r = r + [''] * (len(intest) - len(r))
        code = r[idx['code']].strip()
        n = {k: valore_ciqual(r[idx[k]]) for k in NUTRIENTI}
        dati[code] = {'nome_fr': ' '.join(r[idx['nome_fr']].split()), 'n': n}
    return dati


def leggi_usda(cartella: Path, fdc_ids: set[str]) -> dict[str, dict]:
    z = zipfile.ZipFile(cartella / scarica.USDA['file'])
    base = 'FoodData_Central_sr_legacy_food_csv_2018-04/'
    nomi = {}
    with z.open(base + 'food.csv') as f:
        for r in csv.DictReader(io.TextIOWrapper(f, encoding='utf-8')):
            if r['fdc_id'] in fdc_ids:
                nomi[r['fdc_id']] = r['description']
    grezzi: dict[str, dict] = {i: {} for i in fdc_ids}
    with z.open(base + 'food_nutrient.csv') as f:
        for r in csv.DictReader(io.TextIOWrapper(f, encoding='utf-8')):
            if r['fdc_id'] in fdc_ids and r['nutrient_id'] in USDA_NUTRIENTI:
                grezzi[r['fdc_id']][USDA_NUTRIENTI[r['nutrient_id']]] = float(r['amount'])
    dati = {}
    for fid in fdc_ids:
        if fid not in nomi:
            raise SystemExit(f'USDA: fdc_id {fid} non trovato in SR Legacy')
        g = grezzi[fid]
        fib = g.get('fiber')
        carbs = max(0.0, g.get('carbs_diff', 0.0) - (fib or 0.0))
        n = {
            'protein': g.get('protein'), 'fat': g.get('fat'), 'carbs': carbs, 'fiber': fib,
            'sugars': g.get('sugars'), 'satFat': g.get('satFat'),
            'salt': g['sodium_mg'] * 2.5 / 1000 if 'sodium_mg' in g else None,
            'alcohol': g.get('alcohol'),
        }
        if n['protein'] is None or n['fat'] is None or 'carbs_diff' not in g:
            raise SystemExit(f'USDA {fid}: macronutrienti incompleti')
        n['kcal'] = energia_ue(n)
        dati[fid] = {'nome_fr': nomi[fid], 'n': n}
    return dati


def costruisci() -> dict:
    sel = leggi_selezione()
    ciq = leggi_ciqual(scarica.scarica_ciqual())
    usda_ids = {r['codice'].split(':', 1)[1] for r in sel if r['codice'].startswith('usda:')}
    usda = leggi_usda(scarica.scarica_usda(), usda_ids) if usda_ids else {}

    alimenti, ids, avvisi = [], set(), []
    for r in sel:
        if r['codice'].startswith('usda:'):
            fid = r['codice'].split(':', 1)[1]
            src, ref, orig = 'usda', f'USDA FDC {fid} (SR Legacy)', usda[fid]
        else:
            if r['codice'] not in ciq:
                raise SystemExit(f'riga {r["riga"]}: codice CIQUAL {r["codice"]} inesistente')
            src, ref, orig = 'ciqual', f'CIQUAL 2025 {r["codice"]}', ciq[r['codice']]
        n = dict(orig['n'])
        for k in ('protein', 'carbs', 'fat'):
            if n.get(k) is None:
                raise SystemExit(f'riga {r["riga"]} {r["nome"]}: manca {k} nella fonte')
        nota = r['nota']
        if n.get('kcal') is None:
            n['kcal'] = energia_ue(n)
            if 'kcal calcolate' not in nota:
                nota = (nota + '; ' if nota else '') + 'kcal calcolate dai macronutrienti con i fattori UE'
        for k in r['senza']:
            if k not in NUTRIENTI or k in ('kcal', 'protein', 'carbs', 'fat'):
                raise SystemExit(f'riga {r["riga"]}: non si puo togliere {k}')
            n[k] = None
        id_ = slug(r['nome'])
        if id_ in ids:
            raise SystemExit(f'riga {r["riga"]}: id duplicato {id_}')
        ids.add(id_)
        item = {
            'id': id_, 'name': r['nome'], 'aliases': r['alias'], 'category': r['categoria'],
            'per100g': arrotonda(n), 'source': src, 'sourceRef': ref,
            'sourceName': orig['nome_fr'], 'portions': r['porzioni'],
        }
        if nota:
            item['note'] = nota
        # controllo di Atwater (fattori UE completi): segnala, non blocca
        k = item['per100g']['kcal']
        e = energia_ue(item['per100g'])
        if abs(k - e) > max(0.10 * k, 3):
            avvisi.append(f'Atwater: {id_} kcal {k} vs {e:.1f}')
        alimenti.append(item)

    meta = {
        'nome': 'Database alimenti di Foro',
        'descrizione': 'Valori nutrizionali per 100 g di parte edibile (100 ml per i liquidi, densita circa 1).',
        'fonti': [
            {
                'id': 'ciqual',
                'citazione': 'Anses. 2025. Table de composition nutritionnelle des aliments Ciqual 2025. '
                             'https://doi.org/10.57745/RDMHWY',
                'versione': 'Ciqual 2025 (file del 2025-11-03, pubblicati il 2025-11-19)',
                'licenza': 'Licence Ouverte / Open Licence 2.0 (Etalab)',
                'licenzaUrl': 'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
                'file': 'Table Ciqual 2025_FR_2025_11_03.xlsx',
                'md5': scarica.CIQUAL['files']['Table Ciqual 2025_FR_2025_11_03.xlsx'][1],
            },
            {
                'id': 'usda',
                'citazione': 'U.S. Department of Agriculture, Agricultural Research Service. '
                             'FoodData Central, SR Legacy (2018). https://fdc.nal.usda.gov/',
                'versione': 'SR Legacy 2018-04',
                'licenza': 'Pubblico dominio (CC0 1.0)',
                'file': scarica.USDA['file'],
                'md5': scarica.USDA['md5'],
            },
        ],
        'modifiche': [
            'selezione di alimenti usati nella dieta italiana, nomi italiani, alias e porzioni aggiunti da Foro',
            "valori '< x' e 'traces' posti a 0 (stessa regola del calcolo dell'energia ANSES)",
            'kcal mancanti calcolate con i fattori del Regolamento UE 1169/2011',
            'USDA: carboidrati disponibili = per differenza meno fibre; kcal ricalcolate con i fattori UE; sale = sodio x 2,5',
            "campo 'senza' in selezione.csv: nutrienti omessi quando la fonte non rappresenta l'alimento (vedi 'note')",
        ],
        'numeroAlimenti': len(alimenti),
    }
    return {'meta': meta, 'alimenti': alimenti, 'avvisi': avvisi}


def main() -> None:
    res = costruisci()
    avvisi = res.pop('avvisi')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    testo = json.dumps(res, ensure_ascii=False, separators=(',', ':'))
    OUT.write_text(testo + '\n', encoding='utf-8')
    cats: dict[str, int] = {}
    for a in res['alimenti']:
        cats[a['category']] = cats.get(a['category'], 0) + 1
    print(f'scritto {OUT.relative_to(ROOT)}: {len(res["alimenti"])} alimenti, {len(testo) / 1024:.0f} KB')
    for c, n in sorted(cats.items(), key=lambda x: -x[1]):
        print(f'  {c}: {n}')
    for a in avvisi:
        print('  AVVISO', a)


if __name__ == '__main__':
    main()
