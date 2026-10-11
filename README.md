# IR Remote Lab v11 — GitHub Pages / PWA

Questa versione parte dalla v10 stabile e mantiene il firmware Arduino RAW universale della v06.

## Cosa cambia nella v11

- pronta per **GitHub Pages** da sottocartella repository;
- cartella web pubblicabile direttamente da `docs/`;
- nessun path assoluto: funziona anche come `https://utente.github.io/nome-repository/`;
- PWA installabile su telefono/PC;
- service worker per l'app shell offline;
- interfaccia mobile migliorata;
- ricerca telecomandi in Home;
- indicatore grafico dei tasti pronti;
- backup completo di tutti i telecomandi + ripristino;
- nuova modalità **Sposta tasti** nell'editor;
- trascinamento con mouse o touch;
- griglia opzionale da 5 px;
- regolazione fine con frecce tastiera (`Shift` + freccia = 5 px);
- annullamento dell'ultimo spostamento;
- toast non bloccanti per le operazioni principali.

Il firmware Arduino non cambia:

```text
arduino/IRUniversalUno_v06.ino
```

## Pubblicazione su GitHub Pages

1. Crea un nuovo repository GitHub, per esempio `ir-remote`.
2. Copia nel repository **tutto il contenuto di questa cartella**.
3. Fai commit/push sul branch `main`.
4. In GitHub apri **Settings → Pages**.
5. In **Build and deployment** scegli **Deploy from a branch**.
6. Seleziona:
   - Branch: `main`
   - Folder: `/docs`
7. Salva.

L'indirizzo sarà del tipo:

```text
https://TUO-USERNAME.github.io/ir-remote/
```

La v11 usa soltanto URL relativi (`./...`), quindi non dipende dal nome del repository.

## Uso da Android

1. Apri il sito con Chrome.
2. Collega Arduino Uno al telefono tramite USB OTG / USB-C.
3. Premi **Collega Arduino**.
4. Seleziona la porta proposta da Chrome.
5. Se Chrome propone **Installa app**, puoi installare la PWA sulla schermata Home.

Se il browser non espone `navigator.serial`, il pulsante di connessione viene disabilitato e viene mostrato che Web Serial non è disponibile.

## Spostare i tasti

Apri un telecomando e vai su:

```text
Modifica tasti → Sposta tasti
```

Poi:

- trascina direttamente un tasto con mouse o dito;
- con **Griglia 5 px** attiva, il trascinamento viene allineato alla griglia;
- seleziona un tasto e usa le frecce per spostarlo di 1 px;
- `Shift + freccia` lo sposta di 5 px;
- **Annulla spostamento** ripristina l'ultima posizione.

Le coordinate vengono salvate automaticamente nel telecomando.

## Passaggio da localhost a GitHub Pages

`localStorage` dipende dall'origine del sito. I telecomandi salvati su:

```text
http://localhost:8000
```

non compaiono automaticamente su:

```text
https://TUO-USERNAME.github.io/ir-remote/
```

Per questo la v11 aggiunge in Home:

```text
Backup
Ripristina
```

Prima del passaggio:

1. apri la vecchia versione su localhost;
2. usa la v11 su localhost e premi **Backup**;
3. apri la versione GitHub Pages;
4. premi **Ripristina** e seleziona il file JSON.

Il ripristino aggiunge i telecomandi del backup senza cancellare quelli già presenti.

## Avvio locale

Windows:

```text
serve.bat
```

oppure manualmente:

```bash
python -m http.server 8000 --directory docs
```

poi apri:

```text
http://localhost:8000
```

## Struttura repository

```text
arduino/
  IRUniversalUno_v06.ino

docs/
  index.html
  app.js
  styles.css
  remotes_db.js
  external_db.js
  manifest.webmanifest
  service-worker.js
  .nojekyll
  icons/
  DB_LICENSES.md
  IRDB_INTEGRATION.md

examples/

tests/
  smoke_test.py
  TEST_MATRIX.md
  TEST_REPORT.txt

serve.bat
serve.sh
README_IT.md
```

## Database

Restano integrate le sorgenti già presenti nella v10:

- database locale;
- FlipperDevices IRDB;
- irdb di Simon Peter e contributori.

Il database esterno non viene inserito nel firmware Arduino.

## Test

La suite browser utilizza Chromium con Web Serial simulata e verifica i flussi principali della web app, compresi:

- handshake seriale;
- acquisizione;
- riconoscimento;
- clonazione;
- riapprendimento;
- trasmissione RAW;
- ricerca modello;
- ricerca automatica;
- import/export JSON;
- database esterni;
- cache DB offline;
- aggiunta/rimozione/rinomina tasti;
- spostamento tasti con drag;
- undo;
- regolazione da tastiera;
- layout editor a 390 px;
- backup completo;
- compatibilità dei path per GitHub Pages;
- assenza di errori JavaScript non gestiti.

Il risultato dell'ultima esecuzione è in `tests/TEST_REPORT.txt`.
