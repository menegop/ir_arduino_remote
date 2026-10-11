# IR Remote Lab v11 - matrice test

| Area | Scenario verificato | Esito |
|---|---|---|
| Firmware/Web | contratto seriale Arduino v06 ↔ web (`LEARN`, `CANCEL`, `TXRAW_*`, `RX*`) | PASS |
| GitHub Pages | asset locali con path relativi, nessun path `/...` che rompe il sottopercorso repository | PASS |
| PWA | manifest `start_url` e `scope` relativi `./` | PASS |
| PWA | service worker registrato e cache versionata v11 | PASS |
| GitHub Pages | `.nojekyll` presente | PASS |
| Home | caricamento, badge v11, elenco telecomandi | PASS |
| Serial | connessione e handshake PING/DEBUG/STATUS | PASS |
| Serial | disconnessione pulita | PASS |
| Acquisizione | cambio pagina durante LEARN senza popup stale `CANCELLED` | PASS |
| Database | irdb disponibile anche se l'indice Flipper primario fallisce | PASS |
| Database | fallback Flipper tramite GitHub tree | PASS |
| Database | sincronizzazione manuale | PASS |
| Database | cache offline | PASS |
| Clone | pattern integrati renderizzati | PASS |
| Clone | almeno 23 pattern e pulsanti dentro viewBox | PASS |
| Clone | Skip durante apprendimento | PASS |
| Clone | Annulla durante apprendimento | PASS |
| Clone | pattern custom JSON | PASS |
| Clone | JSON pattern non valido gestito inline | PASS |
| Clone | copia prompt IA | PASS |
| Clone | due catture diverse, retry automatico A/B/B | PASS |
| Riconoscimento | tre catture fisiche | PASS |
| Riconoscimento | candidato locale | PASS |
| Riconoscimento | catture salvate realmente nel telecomando | PASS |
| Telecomando virtuale | trasmissione TXRAW | PASS |
| Telecomando virtuale | cambio telecomando dal select | PASS |
| Editor | riapprendimento tasto | PASS |
| Editor | rinomina tasto | PASS |
| Editor | aggiungi tasto + apprendimento | PASS |
| Editor | elimina tasto | PASS |
| Editor | spostamento tasto con drag/pointer | PASS |
| Editor | salvataggio coordinate dopo drag | PASS |
| Editor | annulla ultimo spostamento | PASS |
| Editor | regolazione fine con frecce tastiera | PASS |
| Editor mobile | viewport 390 px senza overflow orizzontale e controlli visibili | PASS |
| Editor | elimina telecomando + refresh Home | PASS |
| Ricerca modello | risultato Flipper | PASS |
| Ricerca modello | risultato irdb | PASS |
| Ricerca modello | Test Power RAW | PASS |
| Ricerca modello | importazione profilo | PASS |
| Ricerca automatica | avvio e Stop | PASS |
| Ricerca automatica | conferma `Ha reagito` e salvataggio | PASS |
| JSON | import valido | PASS |
| JSON | JSON invalido gestito inline | PASS |
| JSON | export singolo telecomando | PASS |
| Backup | export completo di tutti i telecomandi | PASS |
| Backup | ripristino backup completo | PASS |
| Avanzata | invio frame | PASS |
| Avanzata | carrier fuori range rifiutato | PASS |
| JavaScript | nessun pageerror/console error non gestito durante lo smoke test | PASS |

Il test usa Chromium reale e una porta Web Serial emulata con il protocollo testuale dell'Uno v06. La compatibilità GitHub Pages/PWA viene verificata anche staticamente sui path e sul manifest. L'hardware IR fisico deve comunque essere verificato sull'installazione reale.
