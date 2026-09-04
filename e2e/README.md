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

## Een nieuw scherm bekijken vóór het gedeployd is

`TASKFLOW_URL` wijst standaard naar de live site op GitHub Pages, dus een
scherm dat je net gebouwd hebt, staat daar nog niet. Tegen een lokale build
draaien kan wel — met één addertje:

```bash
npm run build && npx vite preview --port 4173 --host 127.0.0.1
```

en dan een config met de baseURL erop én een omweg om de proxy heen:

```ts
proxy: { server: process.env.HTTPS_PROXY!, bypass: '127.0.0.1,localhost' }
```

Zonder die `bypass` stuurt Chromium ook het verkeer naar 127.0.0.1 door de
agent-proxy, die alleen CONNECT-tunnels aanvaardt. Je krijgt dan geen
foutmelding over de proxy maar een lege pagina met de tekst van de relay erin,
en de test faalt op "wacht op E-mailadres" — wat eruitziet alsof het inlogveld
weg is.

## De testaccounts

Vier schermen lagen buiten bereik zolang er maar één testaccount was: Workload,
Wettelijke kalender en Medewerkers vragen de rol kantoorbeheerder, Goedkeuren
vraagt goedkeuringsrecht. En de teammuur (migratie 0039) valt alleen van
BUITEN te beproeven — met een account dat er niet bij hoort.

Daarom zijn er vijf. Ze staan in `e2e/helpers.ts` als `ACCOUNTS` en delen
allemaal hetzelfde `TASKFLOW_TEST_PASSWORD`: bewust, zodat er geen tweede
geheim is om kwijt te raken.

| account | rol | niveau | team | waarvoor |
| --- | --- | --- | --- | --- |
| `test@pato.be` | medewerker | junior | AAL | het gewone werk; heeft taken op zijn naam |
| `e2e-beheer@pato.be` | kantoorbeheerder | partner | ZAV1 | de drie beheerschermen |
| `e2e-manager@pato.be` | medewerker | manager | ZAV1 | goedkeuren zonder beheerrechten |
| `e2e-ant@pato.be` | medewerker | senior | ANT | de teammuur, van buitenaf |
| `e2e-geenteam@pato.be` | medewerker | junior | — | wat iemand zonder team ziet |

De laatste twee hebben met opzet **geen enkele taak** op hun naam. De muur kent
een uitzondering voor dossiers waar een taak van jou op staat; zonder taken meet
je de teamregel zuiver.

`e2e-manager` en `e2e-beheer` bewijzen samen dat de twee assen los staan:
goedkeuren hangt aan de graad (migratie 0042), beheren aan de rol.

Deze accounts bestaan alleen op de testomgeving en horen niet in een echte
kantoorinstallatie. Wie Taskflow ergens anders opzet: laat ze weg.
