"""Lettore minimo di file .xlsx con la sola libreria standard (zipfile + xml).

Serve a leggere la tabella CIQUAL senza installare pacchetti: restituisce le righe
del primo foglio come liste di stringhe (celle vuote = '').
"""
from __future__ import annotations

import re
import zipfile
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PKG_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'


def _col_index(ref: str) -> int:
    """'A1' -> 0, 'AB12' -> 27."""
    letters = re.match(r'[A-Z]+', ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _shared_strings(z: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
    except KeyError:
        return []
    out = []
    for si in root.findall('m:si', NS):
        # testo semplice o testo formattato (più run <r><t>)
        out.append(''.join(t.text or '' for t in si.iter(f"{{{NS['m']}}}t")))
    return out


def _sheet_paths(z: zipfile.ZipFile) -> list[tuple[str, str]]:
    wb = ET.fromstring(z.read('xl/workbook.xml'))
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    target = {r.get('Id'): r.get('Target') for r in rels.findall(f'{{{PKG_NS}}}Relationship')}
    out = []
    for s in wb.find('m:sheets', NS).findall('m:sheet', NS):
        rid = s.get(f'{{{R_NS}}}id')
        path = target[rid].lstrip('/')
        if not path.startswith('xl/'):
            path = 'xl/' + path
        out.append((s.get('name'), path))
    return out


def read_rows(path: str, sheet: int = 0) -> list[list[str]]:
    with zipfile.ZipFile(path) as z:
        strings = _shared_strings(z)
        name, sheet_path = _sheet_paths(z)[sheet]
        root = ET.fromstring(z.read(sheet_path))
    rows: list[list[str]] = []
    for row in root.iter(f"{{{NS['m']}}}row"):
        cells: dict[int, str] = {}
        for c in row.findall('m:c', NS):
            t = c.get('t')
            v = c.find('m:v', NS)
            if t == 's' and v is not None:
                val = strings[int(v.text)]
            elif t == 'inlineStr':
                val = ''.join(x.text or '' for x in c.iter(f"{{{NS['m']}}}t"))
            else:
                val = v.text if v is not None and v.text is not None else ''
            cells[_col_index(c.get('r'))] = val
        if cells:
            width = max(cells) + 1
            rows.append([cells.get(i, '') for i in range(width)])
        else:
            rows.append([])
    return rows
