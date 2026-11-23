# Foro

Palestra, corsa, cibo e salute in un posto solo. Una web app (PWA) in italiano, pensata per il telefono, che si collega al Garmin Venu 4.

Il nome viene dal Foro Italico: lo Stadio dei Marmi la mattina presto, la pista in terra rossa. L'elemento che torna in tutta l'app è la **corsia**: ogni numero con un obiettivo (calorie, proteine, serie, passi) è una corsia di pista che si riempie evento per evento.

**App:** <https://mattyprog.github.io/foro/>

## Cosa fa

- **Dieta, stile Cal AI.** Fotografi il piatto e Gemini riconosce gli alimenti e stima i grammi; le calorie le calcola poi il database sui grammi, che puoi correggere prima di salvare. In alternativa: codice a barre (Open Food Facts), ricerca, o il pasto scritto a parole ("80 g di pasta, 150 g di pollo"), che senza AI viene calcolato sul telefono.
- **Obiettivi che si adattano.** Calorie e macro partono dalle formule (metabolismo, attività, tipo di giornata) e dalla terza settimana si correggono sul peso reale, con la revisione del lunedì.
- **Cucina romana.** Piatti tipici calcolati da ricetta con porzioni da trattoria (carbonara, cacio e pepe, supplì, pasta e ceci...) e frutta e verdura di stagione nel Lazio.
- **Allenamenti passati e nuovi.** Storico unico di sedute in palestra e attività Garmin (corse con passo per chilometro, zone cardiache e percorso).
- **La tua scheda.** Schede di partenza da modificare, esercizi, serie, ripetizioni, recuperi, giorni; volume settimanale per muscolo.
- **Modalità palestra.** Schermo sempre acceso, "la volta scorsa", carico consigliato con la progressione doppia, timer di recupero con vibrazione, sostituzione degli esercizi, record.
- **Salute.** Sonno, HRV notturna rispetto alla tua fascia normale, FC a riposo, Body Battery, peso con la linea di tendenza, e un semaforo di prontezza che consiglia di alleggerire quando i numeri (o come ti senti) lo chiedono.

## I tuoi dati

- Tutto resta **sul telefono** (IndexedDB). Non c'è un server e non c'è un account.
- Il repository è pubblico: contiene il codice, mai i dati. I dati Garmin passano da qui solo **cifrati** (AES-256-GCM) con una password che conosci solo tu.
- La chiave di Gemini e la password della sync restano sul telefono e non finiscono nemmeno nella copia di sicurezza.
- Copia di sicurezza: da Profilo esporti un file cifrato con una password a scelta e lo ripristini su un altro telefono.

## Installazione sul telefono

1. Apri <https://mattyprog.github.io/foro/> con Safari (iPhone) o Chrome (Android).
2. iPhone: Condividi > Aggiungi alla schermata Home. Android: menu > Installa app.
3. Al primo avvio inserisci i tuoi dati (servono per gli obiettivi). Per vedere l'app piena prima di avere dati veri: Profilo > Dati di prova.

## Collegare il Garmin

Una volta sola, circa 10 minuti: chiave personale Garmin, password della sync, due secret nel repository. Istruzioni passo passo in [docs/GARMIN.md](docs/GARMIN.md).

Finché la sync non è configurata puoi importare a mano i file `.fit` (o gli `.zip` esportati da Garmin Connect) da Profilo.

## Foto del cibo

Serve una chiave API di Google AI Studio (Profilo > Foto del cibo). Ogni foto costa meno di un centesimo sul tuo credito; l'app mostra la spesa stimata. Senza chiave funzionano lo stesso ricerca, codice a barre e pasto scritto.

## Sviluppo

```bash
npm ci
npm run dev      # server di sviluppo
npm test         # Vitest
npm run build    # build in dist/
```

Sync Garmin (Python 3.12): `scripts/sync/`, test con `python -m unittest discover scripts/sync/tests`.

Struttura:

| Cartella | Cosa c'è |
| --- | --- |
| `src/features/` | schermate: oggi, dieta, allenamento, salute, profilo |
| `src/lib/nutrition/` | database alimenti, obiettivi, foto, testo, codici a barre |
| `src/lib/training/` | schede, modalità palestra, progressione, record, volume |
| `src/lib/health/` | basi personali e semaforo di prontezza |
| `src/lib/garmin/`, `src/lib/fit/` | busta cifrata, importazione Garmin e file FIT |
| `src/db/` | schema dei dati (Dexie) |
| `scripts/sync/` | ponte Garmin per la GitHub Action |

Il deploy su GitHub Pages parte a ogni push su `main` (`.github/workflows/deploy.yml`), dopo test e build.

## Fonti

Valori nutrizionali: Anses, Table de composition nutritionnelle des aliments Ciqual 2025 (Licence Ouverte 2.0); USDA FoodData Central SR Legacy (pubblico dominio); prodotti confezionati: Open Food Facts (ODbL). Dettagli in [docs/ALIMENTI.md](docs/ALIMENTI.md).

Dati Garmin: Garmin Connect Personal API, in sola lettura. Font: Bricolage Grotesque, Figtree, Archivo (SIL Open Font License). Icone: Phosphor (MIT).

## Avvertenza

Foro non è un dispositivo medico e non sostituisce medico o nutrizionista. Le soglie di prontezza e di progressione sono valori di partenza prudenti, modificabili.
