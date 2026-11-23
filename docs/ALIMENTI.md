# Database alimenti di Foro: fonti, licenze e metodo

Questo documento descrive i dati nutrizionali inclusi nel repository (`src/data/`) e come si ricostruiscono.
Regola generale del progetto: **un dato che manca resta vuoto (`undefined`), mai 0**.

## Fonti e licenze

| Fonte | Uso | Licenza | Nel repo |
|---|---|---|---|
| **CIQUAL 2025** (Anses), tabella del 2025-11-03 pubblicata il 2025-11-19, DOI [10.57745/RDMHWY](https://doi.org/10.57745/RDMHWY) | fonte principale: 765 alimenti | [Licence Ouverte / Open Licence 2.0 (Etalab)](https://www.etalab.gouv.fr/licence-ouverte-open-licence/): riuso e ridistribuzione consentiti citando la fonte e la data, indicando le modifiche | si |
| **USDA FoodData Central, SR Legacy** (aprile 2018) | solo per i buchi di CIQUAL: 16 alimenti (guanciale, broccoletti, fiori di zucca, borlotti, lupini, yogurt greco, fiocchi di latte, whey...) | pubblico dominio (CC0 1.0) | si |
| **Open Food Facts** | prodotti confezionati, letti in tempo reale dal codice a barre (`src/lib/nutrition/openfoodfacts.ts`) | ODbL 1.0 | **no**: i prodotti vengono salvati solo sul telefono dell'utente |
| CREA, BDA-IEO | esclusi | non ridistribuibili in un repository pubblico | no |

Testo di attribuzione da mostrare nell'app (costante `ATTRIBUTION` in `src/lib/nutrition/foodDb.ts`):

> Valori nutrizionali: Anses, Table de composition nutritionnelle des aliments Ciqual 2025 (Licence Ouverte 2.0); USDA FoodData Central SR Legacy (pubblico dominio); prodotti confezionati: Open Food Facts (ODbL). Selezione, nomi italiani, porzioni e ricette: Foro.

La citazione completa, la versione, la licenza e l'MD5 dei file sorgente sono anche dentro i JSON (`meta.fonti`), insieme all'elenco delle modifiche (`meta.modifiche`).

## Contenuto

- `src/data/alimenti.json`: **781 alimenti** in 24 categorie (verdura 109, dolci 92, carne 74, pesce 64, piatti pronti 57, pasta riso e cereali 50...), materie prime crude **e cotte** (quando CIQUAL ha la versione cotta si usa quella), latticini e formaggi italiani, salumi, pane, frutta e verdura romana (carciofi, cicoria, puntarelle, broccoletti, agretti), condimenti, bevande, dolci, whey. Ogni voce ha nome italiano, alias per la ricerca, porzioni in italiano (`1 uovo medio` 55 g, `1 fetta` di pane 30 g, `1 cucchiaio` di olio 10 g, `porzione` di pasta 80 g a crudo), codice della fonte (`sourceRef`) e nome originale (`sourceName`).
- `src/data/ricette.json`: **45 piatti** romani e italiani calcolati da ricetta (primi 12, pizza e street food 12, secondi 10, colazione e bar 6, contorni 5).
- `src/data/stagionalita-lazio.json`: calendario indicativo di frutta e verdura del Lazio, mese per mese (ARSIAL e Campagna Amica).

Valori per 100 g di parte edibile (100 ml per i liquidi): `kcal`, `protein`, `carbs` (carboidrati disponibili), `fat`, e quando presenti `fiber`, `sugars`, `satFat`, `salt`. Per il controllo di coerenza ci sono anche `alcohol`, `polyols`, `organicAcids` se maggiori di zero.

## Regole sui valori

1. **Cella vuota o `-`**: dato mancante, il campo non c'è. Oggi mancano zuccheri in 26 voci, saturi in 16, sale in 14, fibre in 2.
2. **`traces` e `< x`**: valgono **0**. È la regola con cui ANSES calcola l'energia della tabella: provando le alternative (meta del limite, limite intero) i valori diventano incoerenti con le kcal pubblicate, mentre con lo 0 solo 2 voci su 781 si scostano più del 2% dal calcolo di Atwater.
3. **Energia**: colonna `Energie, Règlement UE N° 1169/2011 (kcal/100 g)`. Se manca si calcola con i fattori UE: 4 kcal/g proteine e carboidrati disponibili, 9 grassi, 2 fibre, 7 alcol, 2,4 polioli, 3 acidi organici.
4. **Proteine**: azoto x 6,25 (definizione del Regolamento UE).
5. **USDA**: carboidrati disponibili = carboidrati per differenza meno fibre; energia ricalcolata con i fattori UE (non i fattori di Atwater specifici dell'USDA); sale = sodio x 2,5.
6. **Colonna `senza` di `selezione.csv`**: nutrienti tolti di proposito quando la voce sorgente non rappresenta l'alimento italiano. Oggi riguarda il sale di 4 voci: guanciale (guancia fresca USDA, il guanciale stagionato è molto più salato), porchetta (valori della coppa di maiale arrosto CIQUAL), lupini in salamoia e agretti (valori della salicornia). Le altre approssimazioni sono spiegate nel campo `note` (es. puntarelle con i valori della cicoria verde, stessa specie).
7. **Coerenza**: ogni alimento e ogni piatto passano il controllo di Atwater (kcal dichiarate contro 4P + 4C + 9G + 2 fibre, entro il 10% o 3 kcal). Lo verifica `src/lib/nutrition/database.test.ts`.

## Metodo dei piatti

- Ingredienti **crudi**, pesati come in cucina, che puntano agli id di `alimenti.json`; resa a cotto (`yieldGrams`); porzione servita tipica (`servingGrams`: trattoria, bar, forno al taglio).
- Valori per 100 g = somma degli ingredienti / resa. Per porzione = valori per 100 g x porzione.
- Un nutriente opzionale (fibre, zuccheri, saturi, sale) resta vuoto se gli ingredienti che non lo riportano pesano più del 5% della ricetta (acqua esclusa).
- `variability` (es. 0,25 per la carbonara) è lo scarto tipico tra cucine diverse: insieme all'incertezza sui grammi produce l'intervallo di calorie mostrato dopo una foto.
- Ogni piatto ha una `note` con le ipotesi: olio assorbito nelle fritture, grasso del guanciale che resta nel condimento, pasta che raddoppia di peso in cottura, quanto olio si conta nei contorni ripassati.
- Confronto con stime indipendenti fatte sulle ricette canoniche: 14 piatti su 20 entro il 15%. Gli scarti maggiori dipendono da ipotesi dichiarate: carciofi alla romana +39% (si conta tutto l'olio del tegame, 10 g), gnocchi al sugo +34% (gnocchi confezionati CIQUAL a 176 kcal/100 g e 5 g di olio), pizza rossa +23% e suppli +16% (pezzo da 120 g invece di 100 g), coda alla vaccinara e pasta e ceci +18% (porzione da trattoria più grande).

## Riproducibilità

Servono solo Python 3 con la libreria standard.

```bash
python scripts/fooddb/scarica.py              # scarica CIQUAL 2025 e USDA SR Legacy in scripts/fooddb/raw/ e verifica gli MD5
python scripts/fooddb/costruisci_alimenti.py  # selezione.csv + fonti -> src/data/alimenti.json
python scripts/fooddb/costruisci_ricette.py   # ricette.json (sorgente) + alimenti -> src/data/ricette.json
```

- `scripts/fooddb/selezione.csv` è il file versionato che decide cosa entra: `codice;nome;alias;categoria;porzioni;senza;nota` (codice CIQUAL o `usda:<fdc_id>`, alias e porzioni separati da `|`, porzioni come `etichetta=grammi`).
- `scripts/fooddb/ricette.json` è la sorgente dei piatti (ingredienti, resa, porzione, variabilità, nota).
- CIQUAL si scarica da Recherche Data Gouv con l'endpoint a zip `api/access/datafiles/<id,id>`: il download del singolo file (`api/access/datafile/...`) passa da uno storage S3 che in questa rete chiudeva la connessione, e `ciqual.anses.fr` rispondeva 503.
- `raw/` e `.venv/` sono ignorati da git: i file sorgente non stanno nel repository, si riscaricano.

## Distribuzione nell'app

I JSON restano in `src/data/` e si caricano con `import()` dinamico (`src/lib/nutrition/foodDb.ts`): Vite li mette in chunk separati con nome versionato che **non pesano sul primo caricamento** e che il service worker della PWA mette in cache (`globPatterns` include `js`), quindi la ricerca funziona offline. Misurati con una build isolata del modulo:

| Chunk | Dimensione | gzip |
|---|---|---|
| alimenti | 369 KB | 60 KB |
| ricette | 59 KB | 11 KB |
| codice del motore di nutrizione (zod escluso) | 70 KB | 24 KB |

Un file in `public/data/` avrebbe richiesto fetch e versionamento manuali senza risparmiare byte.

## Limiti noti

- CIQUAL descrive prodotti francesi: per alcuni prodotti italiani i valori sono approssimati (nota nel campo `note`). Il guanciale viene dalla guancia di maiale cruda USDA, non stagionata (sale omesso).
- Le porzioni sono tipiche, non misurate: servono per partire, l'utente corregge i grammi.
- Il calendario stagionale è indicativo e non comprende i cipollotti (assenti in CIQUAL).
