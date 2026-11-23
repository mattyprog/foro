# Garmin e Foro: come funziona la sync

Foro legge i dati del tuo Venu 4 dall'**API personale ufficiale di Garmin** (Garmin Connect Personal API), in sola lettura.
Garmin non permette di chiamarla dal browser del telefono, quindi c'è un passaggio in mezzo:

1. l'orologio si sincronizza con l'app Garmin Connect sul telefono, come sempre;
2. ogni 3 ore una **GitHub Action** di questo repository scarica i dati nuovi con la tua chiave personale;
3. li **cifra** con una password che scegli tu e pubblica solo il file cifrato (`garmin.json.enc`) sul ramo `data`;
4. l'app scarica il file e lo **decifra sul telefono** con la stessa password.

Ti servono 10 minuti, una volta sola.

## 1. Crea la chiave personale Garmin

1. Apri <https://connect.garmin.com/app/settings/personalApiToken> (accedi con il tuo account Garmin).
2. Crea una nuova chiave. Come scadenza scegli **1 anno** e **segnati la data** nel calendario, con un promemoria due settimane prima: quando la chiave scade la sync si ferma.
3. Copia la chiave: Garmin te la mostra una volta sola. Incollala subito nel secret del passo 3 e non salvarla altrove (niente note, chat o file nel repository).

La chiave permette solo di leggere i tuoi dati. Se pensi che qualcuno l'abbia vista, revocala dalla stessa pagina e creane un'altra.

## 2. Scegli la password della sync

Serve a cifrare i dati. Il file cifrato è pubblico, quindi la password deve essere **lunga**: almeno 12 caratteri, meglio 4 o 5 parole a caso (per esempio `tavolo lampone vela ottobre`). Non usare la password di Garmin o di GitHub.

Se la dimentichi non perdi niente: i dati restano su Garmin. Ne scegli una nuova (passo 3 e passo 5) e la sync successiva riscarica tutto da capo.

## 3. Aggiungi i secret nel repository

Su GitHub apri il repository, poi **Settings > Secrets and variables > Actions > New repository secret** e crea:

| Nome | Valore |
| --- | --- |
| `GARMIN_PERSONAL_API_KEY` | la chiave Garmin del passo 1 |
| `SYNC_PASSPHRASE` | la password del passo 2 |

I secret non si possono più leggere, neanche da te, e GitHub li nasconde anche nei log.
Finché i due secret non ci sono, il workflow programmato parte ma si ferma al primo passo, senza errori e senza email di fallimento.

Facoltativo, nella scheda **Variables** della stessa pagina:

| Nome | A cosa serve | Predefinito |
| --- | --- | --- |
| `PRIVACY_TRIM_M` | metri tolti a inizio e fine di ogni traccia GPS | `300` |
| `SYNC_TZ` | fuso orario per "oggi" | `Europe/Rome` |

## 4. Avvia la prima sync

Apri **Actions > Garmin sync > Run workflow** e conferma. Se GitHub chiede di abilitare le Actions, abilitale.

La prima volta scarica 12 mesi di attività, i dettagli (giri, traccia, frequenza cardiaca, passo, serie di forza) degli ultimi 90 giorni, 90 giorni di benessere (sonno, HRV, FC a riposo, stress, Body Battery, passi...) e tutto lo storico del peso. Può volerci qualche minuto.

Dopo parte da sola ogni 3 ore (al minuto 23) e scarica solo il nuovo. Gli ultimi 3 giorni vengono sempre riletti, perché Garmin a volte corregge passi e FC a riposo.

Nel log vedi solo conteggi, per esempio `attività: 214 (nuove 2, aggiornate 1, rimosse 0)`. Se mancano i secret il giro finisce senza errori e lo dice nel log: niente viene pubblicato.

Per riscaricare tutto da capo: **Run workflow** con la casella **Riscarica tutto da capo**.

## 5. Collega l'app

Nell'app: **Impostazioni > Garmin**.

- **Repository della sync**: `mattyprog/foro` (utente e nome del repository);
- **Password della sync**: la stessa del secret `SYNC_PASSPHRASE`;
- **Ricordala su questo telefono**: se la spunti, l'app si aggiorna da sola quando la apri (al massimo una volta ogni 30 minuti). Se non la spunti, la password resta solo finché l'app è aperta.

Poi tocca **Scarica i dati adesso**. Importare più volte lo stesso pacchetto non crea doppioni. Quello che hai scritto tu a mano (umore, energia, indolenzimento, pesi inseriti a mano) non viene mai sovrascritto.

## Limiti da sapere

- **Ritardo fino a 3 ore**, più qualche minuto di cache di GitHub (e nelle ore di punta GitHub può avviare i giri programmati anche mezz'ora dopo). Per vedere subito un allenamento: sincronizza l'orologio con Garmin Connect, poi **Actions > Garmin sync > Run workflow**.
- **L'orologio deve aver sincronizzato con Garmin Connect**: la sync legge da Garmin, non dall'orologio.
- **La chiave scade** (dopo 1 anno, se hai seguito il passo 1). Il giro fallisce con "chiave rifiutata da Garmin" e GitHub ti manda un'email. Crea una nuova chiave e aggiorna il secret `GARMIN_PERSONAL_API_KEY`.
- **Sospensione dopo 60 giorni**: nei repository pubblici GitHub sospende le esecuzioni programmate dopo 60 giorni senza attività. La pubblicazione sul ramo `data` dovrebbe contare come attività, ma non è garantito. Di solito GitHub manda prima un'email di avviso; per riprendere: **Actions > Garmin sync > Enable workflow**.
- **Se Garmin non risponde**, il giro finisce senza errori e resta pubblicato il pacchetto precedente: riprova da solo 3 ore dopo.
- **Se cambi password**: aggiorna il secret e la password nell'app. Il giro dopo non riesce ad aprire il vecchio pacchetto e riscarica tutto da capo.

## Cosa è pubblico e cosa no

Il repository è pubblico. Ecco cosa può vedere chiunque:

- il codice dell'app e dello script di sync;
- i log delle Actions: solo conteggi e avvisi generici, mai valori, date, nomi o luoghi;
- sul ramo `data`: `garmin.json.enc` (i tuoi dati, **cifrati**) e `meta.json` (solo data e ora dell'ultima sync).

Non è pubblico:

- la chiave Garmin e la password: stanno nei Secrets;
- i tuoi dati in chiaro: escono da GitHub solo cifrati (AES-256-GCM, chiave ricavata dalla password con PBKDF2 a 600.000 iterazioni) e si decifrano solo sul tuo telefono. Senza password il file è illeggibile; per questo la password deve essere lunga.

In più, anche dentro il file cifrato:

- ogni traccia GPS perde i primi e gli ultimi 300 metri, e ogni punto a meno di 300 metri dalla partenza o dall'arrivo: casa tua non si vede;
- ci sono solo i dati che servono all'app: niente email, niente profilo, niente coordinate di partenza. Il nome delle attività è quello di Garmin Connect, che spesso contiene la città: se non ti va, rinominale su Garmin Connect;
- il ramo `data` ha **un solo commit**, riscritto a ogni giro: le versioni vecchie non si accumulano nella cronologia.

## In alternativa: importare un file FIT

Funziona anche senza la sync. Su Garmin Connect apri l'attività, menu ⋯, **Esporta file originale**. Poi nell'app: **Impostazioni > Importa file FIT**. Garmin lo scarica come ZIP: l'app legge sia lo ZIP sia il `.fit` che contiene (se il telefono non ti lascia scegliere lo ZIP, estrailo e scegli il `.fit`). Anche qui la traccia perde i primi e gli ultimi 300 metri. Se la stessa attività arriva poi dalla sync (stesso tipo, inizio entro 90 secondi), non diventa un doppione: resta una sola attività.

## Per chi mantiene il codice

Script: `scripts/sync/garmin_sync.py` (Python 3.12 o più recente; usa il client Python ufficiale di Garmin). Moduli dell'app: `src/lib/garmin` (busta cifrata, download, import) e `src/lib/fit` (file FIT, tracce).

Prova in locale (Windows; su Linux e macOS il Python del venv è in `.venv/bin/python`):

```sh
python -m venv scripts/sync/.venv
scripts/sync/.venv/Scripts/python -m pip install --require-hashes -r scripts/sync/requirements.txt
scripts/sync/.venv/Scripts/python -m unittest discover scripts/sync/tests
npm test
```

Sync vera in locale, con la chiave e la password nelle variabili d'ambiente (mai in un file del repository):

```sh
scripts/sync/.venv/Scripts/python scripts/sync/garmin_sync.py --out scripts/sync/out --plain data-local/bundle.json
```

`scripts/sync/out/` e `data-local/` sono esclusi da git. `--plain` scrive anche il pacchetto in chiaro, solo per controllarlo: in GitHub Actions viene ignorato.

Le regole su tracce, serie e file FIT esistono in due copie, `scripts/sync/garmin_bridge/` (Python) e `src/lib/fit/` (TypeScript), e devono dare gli stessi numeri. Due fixture con dati **sintetici** lo controllano:

- `tests/fixtures/garmin-envelope.sample.json`: busta prodotta da Python che il TypeScript deve decifrare. Si rigenera con `scripts/sync/tests/make_sample_envelope.py`;
- `tests/fixtures/fit-parity.sample.json`: risultati Python che il TypeScript deve riprodurre. Si rigenera con `scripts/sync/tests/make_parity_fixture.py`.

Se cambi una regola, cambiala in tutte e due le copie, rigenera le fixture e rilancia i due gruppi di test.
