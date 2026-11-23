"""Calcola src/data/ricette.json dai piatti in scripts/fooddb/ricette.json.

Per ogni piatto:
  - somma i nutrienti degli ingredienti (valori per 100 g x grammi / 100, dal database alimenti);
  - divide per la resa a cotto (resaG) e ottiene i valori per 100 g di piatto;
  - calcola la porzione standard servita (porzioneG) e gli ingredienti scalati a una porzione;
  - controlla la coerenza di Atwater: kcal contro 4 x proteine + 4 x carboidrati + 9 x grassi
    (+ 2 x fibre, 7 x alcol, 2,4 x polioli, 3 x acidi organici se presenti) entro il 10%.

Un nutriente opzionale (fibre, zuccheri, saturi, sale) e' lasciato vuoto se gli ingredienti che non
lo riportano pesano piu' del 5% della ricetta (acqua esclusa): meglio un dato mancante che uno falso.

Uso:  python scripts/fooddb/costruisci_ricette.py   (dopo costruisci_alimenti.py)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

QUI = Path(__file__).resolve().parent
ROOT = QUI.parent.parent
ALIMENTI = ROOT / 'src' / 'data' / 'alimenti.json'
SORGENTE = QUI / 'ricette.json'
OUT = ROOT / 'src' / 'data' / 'ricette.json'

OBBLIGATORI = ['kcal', 'protein', 'carbs', 'fat']
OPZIONALI = ['fiber', 'sugars', 'satFat', 'salt']
EXTRA = ['alcohol', 'polyols', 'organicAcids']
SOGLIA_MANCANTI = 0.05


def energia_ue(n: dict) -> float:
    g = lambda k: n.get(k) or 0.0  # noqa: E731
    return (4 * g('protein') + 4 * (g('carbs') - g('polyols')) + 2.4 * g('polyols') + 9 * g('fat')
            + 2 * g('fiber') + 7 * g('alcohol') + 3 * g('organicAcids'))


def atwater_semplice(n: dict) -> float:
    return 4 * n['protein'] + 4 * n['carbs'] + 9 * n['fat'] + 2 * (n.get('fiber') or 0)


def calcola(piatto: dict, db: dict) -> dict:
    tot = {k: 0.0 for k in OBBLIGATORI + OPZIONALI + EXTRA}
    massa_mancante = {k: 0.0 for k in OPZIONALI}
    massa = 0.0
    for ing in piatto['ingredienti']:
        if ing['id'] not in db:
            raise SystemExit(f"{piatto['id']}: ingrediente sconosciuto {ing['id']}")
        if ing['g'] <= 0:
            raise SystemExit(f"{piatto['id']}: grammi non validi per {ing['id']}")
        n = db[ing['id']]['per100g']
        f = ing['g'] / 100
        if ing['id'] != 'acqua':
            massa += ing['g']
        for k in OBBLIGATORI + EXTRA:
            tot[k] += (n.get(k) or 0.0) * f
        for k in OPZIONALI:
            if n.get(k) is None:
                if ing['id'] != 'acqua':
                    massa_mancante[k] += ing['g']
            else:
                tot[k] += n[k] * f
    resa, porz = piatto['resaG'], piatto['porzioneG']
    if resa <= 0 or porz <= 0:
        raise SystemExit(f"{piatto['id']}: resa o porzione non valida")
    per100 = {}
    for k in OBBLIGATORI + OPZIONALI + EXTRA:
        if k in OPZIONALI and massa_mancante[k] > SOGLIA_MANCANTI * massa:
            continue
        v = tot[k] / resa * 100
        if k in EXTRA and v <= 0:
            continue
        per100[k] = round(v, 1) if k == 'kcal' else round(v, 2)
    per_porz = {k: (round(v * porz / 100) if k == 'kcal' else round(v * porz / 100, 1))
                for k, v in per100.items() if k not in EXTRA}
    ricetta = [{'foodId': i['id'], 'grams': round(i['g'] * porz / resa, 1)} for i in piatto['ingredienti']]
    grezzo = sum(i['g'] for i in piatto['ingredienti'])
    return {
        'id': piatto['id'],
        'name': piatto['nome'],
        'aliases': piatto.get('alias', []),
        'category': piatto['categoria'],
        'per100g': per100,
        'source': 'ricetta',
        'sourceRef': 'Ricetta Foro (ingredienti dal database alimenti: CIQUAL 2025 e USDA)',
        'portions': piatto['porzioni'],
        'recipe': ricetta,
        'servingGrams': porz,
        'perServing': per_porz,
        'yieldGrams': resa,
        'rawGrams': round(grezzo, 1),
        'variability': piatto['variabilita'],
        'tags': piatto.get('tag', []),
        'note': piatto['nota'],
    }


def costruisci() -> tuple[dict, list[str]]:
    base = json.loads(ALIMENTI.read_text(encoding='utf-8'))
    db = {a['id']: a for a in base['alimenti']}
    src = json.loads(SORGENTE.read_text(encoding='utf-8'))
    piatti, avvisi, ids = [], [], set()
    for p in src['piatti']:
        if p['id'] in ids or p['id'] in db:
            raise SystemExit(f"id duplicato o gia usato nel database: {p['id']}")
        ids.add(p['id'])
        item = calcola(p, db)
        n = item['per100g']
        k, e, s = n['kcal'], energia_ue(n), atwater_semplice(n)
        if abs(k - e) > 0.10 * k:
            avvisi.append(f"Atwater (UE) {p['id']}: {k} kcal vs {e:.1f}")
        if abs(k - s) > 0.10 * k:
            avvisi.append(f"Atwater (4/4/9) {p['id']}: {k} kcal vs {s:.1f}")
        if not 0.4 <= item['rawGrams'] / item['yieldGrams'] <= 2.5:
            avvisi.append(f"resa sospetta {p['id']}: crudo {item['rawGrams']} g, cotto {item['yieldGrams']} g")
        piatti.append(item)
    meta = {
        'nome': 'Piatti romani e italiani di Foro',
        'metodo': 'Valori calcolati da ricetta: somma degli ingredienti crudi pesati, divisa per la resa a cotto. '
                  'Le porzioni sono quelle tipiche servite (trattoria, bar, forno). Le ipotesi sono nella nota di ogni piatto.',
        'fonti': base['meta']['fonti'],
        'numeroPiatti': len(piatti),
    }
    return {'meta': meta, 'piatti': piatti}, avvisi


def main() -> None:
    res, avvisi = costruisci()
    testo = json.dumps(res, ensure_ascii=False, separators=(',', ':'))
    OUT.write_text(testo + '\n', encoding='utf-8')
    print(f'scritto {OUT.relative_to(ROOT)}: {len(res["piatti"])} piatti, {len(testo) / 1024:.0f} KB')
    for p in res['piatti']:
        s = p['perServing']
        print(f"  {p['name']}: {p['servingGrams']} g -> {s['kcal']} kcal, P {s['protein']} C {s['carbs']} G {s['fat']}"
              f"  ({p['per100g']['kcal']} kcal/100 g)")
    for a in avvisi:
        print('  AVVISO', a)
    if any(a.startswith('Atwater') for a in avvisi):
        sys.exit(1)


if __name__ == '__main__':
    main()
