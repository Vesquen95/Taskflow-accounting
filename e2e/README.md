# End-to-end tests

Deze tests openen de **echte** Taskflow in een echte browser en loggen in met
het testaccount. Ze vullen de unittests aan: die controleren de rekenregels,
deze controleren of het scherm ook doet wat het moet.

Dat verschil is niet theoretisch. Op 27/08/2026 vond de eerste scenariotest
meteen een fout die alle 216 unittests hadden gemist: het vak "Verplichtingen"
in het klantformulier bleef leeg wanneer je sneller klikte dan de catalogus
laadde, waardoor een nieuwe klant geen algemene vergadering en geen
jaarafsluiting kreeg.

## Draaien

```bash
npm run e2e                 # alleen lezen -- veilig
npm run e2e -- --headed     # met zichtbare browser
```

Het testaccount en het wachtwoord komen uit `.env.e2e` in de hoofdmap. Dat
bestand staat in `.gitignore` en hoort daar te blijven:

```
TASKFLOW_TEST_EMAIL=test@pato.be
TASKFLOW_TEST_PASSWORD=...
TASKFLOW_E2E_WRITE=0
```

## Er is geen aparte testomgeving

Deze tests praten met de productiedatabase. Daarom:

- **Lezen mag altijd.** De tests in `werkstromen.spec.ts` kijken alleen.
- **Schrijven staat achter een vlag.** Zet `TASKFLOW_E2E_WRITE=1` om ook de
  tests te draaien die een klant aanmaken. Doe dat bewust, niet standaard.
- **Alles wat een test aanmaakt heet `[E2E]`.** Opruimen kan dus altijd:
  verwijder de klanten met dat voorvoegsel en hun taken.
- **Raak nooit een bestaand dossier aan.** Een test die de status van een echte
  taak wijzigt, wijzigt echt werk.

Wil je dit vaker draaien, dan is een tweede Supabase-project als testomgeving
de nettere weg. Zolang dat er niet is, houdt de vlag de schade beperkt.

## Binnen de ontwikkelomgeving

Chromium draait met `--ssl-version-max=tls1.2` (zie `playwright.config.ts`).
De uitgaande proxy van de Claude-omgeving verbreekt de TLS 1.3-handshake van de
browser, terwijl `curl` in diezelfde omgeving wel werkt. Zonder die vlag faalt
elke test op `net::ERR_CONNECTION_RESET`, wat er ten onrechte uitziet alsof de
site stuk is. Buiten die omgeving is de vlag onschadelijk.
