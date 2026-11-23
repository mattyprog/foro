# Logica di allenamento e prontezza

Funzioni pure, senza React né accesso al database: ricevono dati e restituiscono dati nuovi.
Libreria esercizi in `src/data/esercizi.json`, prontezza in `src/lib/health/`.

## Moduli

| File | A cosa serve |
| --- | --- |
| `library.ts` | libreria esercizi (125), ricerca, sostituzioni per schema motorio, valori di partenza, abbinamento con le chiavi Garmin |
| `templates.ts` | schede di partenza (`full-body-ab-3`, `superiore-inferiore-4`), `createProgramFromStarter`, `todaysPlan`, `isDeloadWeek`, `isHardRun`, `isLegDay` |
| `progression.ts` | doppia progressione, lineare, a RPE, stallo, scarico: `suggestNext`, `evaluateExercise`, `deloadAdvice` |
| `records.ts` | 1RM stimato (Epley), tonnellaggio, record, storico per esercizio, serie a gradini |
| `volume.ts` | serie per muscolo a settimana (registrate e pianificate), confronto con 10-12 |
| `session.ts` | modalità palestra: stato della seduta, timer di recupero, riepilogo, salvataggio e ripresa |
| `run.ts` | zone cardiache, piano corsa progressivo, passo e durate, analisi di una corsa |
| `types.ts`, `dates.ts`, `format.ts` | tipi condivisi, date locali, numeri all'italiana |
| `../health/baselines.ts` | medie e intervalli personali (HRV, FC a riposo, sonno), finestre di 7 e 21 giorni |
| `../health/readiness.ts` | semaforo di prontezza con il motivo in una riga |

## Convenzioni

- Giorno della settimana: 0 = lunedì … 6 = domenica. Date locali `YYYY-MM-DD`; istanti ISO 8601 con offset.
  Dentro lo stato della seduta gli istanti sono millisecondi epoch.
- Carico (`LoggedSet.kg`): manubri e kettlebell = kg del singolo attrezzo; corpo libero = kg aggiunti (0 = solo corpo);
  macchine assistite (`Exercise.assisted`) = kg di aiuto, meno è meglio; esercizi a tempo (`Exercise.timed`) = `reps` sono secondi.
- Il riscaldamento (`type: 'riscaldamento'`) non conta mai per record, volume, tonnellaggio e progressione.
- Schemi motori (`Exercise.pattern`), insieme chiuso: `spinta-orizzontale`, `spinta-verticale`, `tirata-orizzontale`,
  `tirata-verticale`, `squat`, `hinge`, `affondo` (multiarticolari: 6-10 ripetizioni, recuperi lunghi), poi `core`, `trasporto`
  e `isolamento-<muscolo>` (complementari: 10-15 ripetizioni).
- Storico per la progressione: `historyForExercise(sessioni, idEsercizio)` dà le serie fatte, una lista per seduta, dalla più
  recente; esclude le sedute di scarico e quelle non chiuse. `history[0]` è l'ultima volta.
- Libreria personalizzata: le funzioni che cercano un esercizio accettano `exercises` (array, Map o oggetto) al posto di quella inclusa.
  Se l'app salva esercizi propri in Dexie, passare l'unione con quelli inclusi.

## Modalità palestra

```ts
let s = startSession(template, sessioniPassate, Date.now());              // valori dell'ultima volta + suggerimenti
s = withSessionId(s, await db.sessions.add(toGymSession(s)));              // subito in Dexie, senza endedAt
s = completeSet(s, chiaveSerie, Date.now());                               // un tocco: il recupero parte da solo
s = completeSet(s, altraChiave, Date.now(), { kg: 62.5, reps: 6, rpe: 8 }); // con una correzione: due tocchi
await db.sessions.put(toGymSession(s));                                    // dopo ogni cambio
const { state, signals } = tickRest(s, Date.now());                        // 'avviso-10s' e 'fine', una volta sola
const { session, summary } = finishSession(s, Date.now(), { history });    // riepilogo con record e testi italiani
await db.sessions.put(session);
```

Riapertura dell'app: `(await db.sessions.filter((x) => !x.endedAt).toArray())` trova le sedute aperte e
`resumeSession(riga)` ricostruisce lo stato identico, timer di recupero compreso (salva l'istante di fine, non i secondi).

Valori precompilati: quelli dell'ultima volta; se il suggerimento è più leggero (carico che scende) o la seduta è di scarico,
quelli del suggerimento. Il suggerimento resta in `set.suggestion` e si applica con `applySuggestion` o `applySuggestions`.

## Persistenza: `GymSession.foro`

Lo stato della modalità palestra vive in una proprietà opzionale `foro` della seduta (tipo `PersistedGymSession`):
`{ v: 1, modo: 'normale' | 'leggero' | 'scarico', live?: SessionState }`. `modo` resta anche a seduta chiusa, così
gli scarichi non falsano la progressione; `live` sparisce alla chiusura (`endedAt` valorizzato). Chi non conosce `foro` lo ignora.

## Soglie da verificare

Sono valori di partenza prudenti, non ancora verificati su fonti, e si cambiano dalle opzioni:
HRV sotto la mediana dei 21 giorni meno 1,5 deviazioni robuste (almeno 8%), FC a riposo oltre 5 battiti sopra la media dei 7 giorni
precedenti per 2 giorni, sonno sotto le 6 ore, 14 giorni di dati per fidarsi dei confronti personali, zone cardiache al 50-60-70-80-90%
della FC massima (Tanaka come ripiego), allunghi dalla quinta settimana, assestamento ogni quarta settimana del piano corsa.
