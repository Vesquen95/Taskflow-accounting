# Taskflow — Productplan v3 (compliance taakbeheer, Belgisch accountantskantoor)

Status: goedgekeurd door de gebruiker om te bouwen (2026-08-24). Dit is het
volledige technische plan — de developer-agent bouwt hiertegen. Verwacht
verdere aanpassingen na deze eerste build; dit is bewust v1, geen eindstaat.

## Context

- Jurisdictie: **België**. Deadlines volgen Belgische wettelijke kalenders
  (FOD Financiën, NBB), geen generiek herhaalpatroon.
- Schaal: middelgroot kantoor — meerdere medewerkers, ~50-500 klanten.
- Drie bronnen van taakwijziging, alle drie eersteklas: **het systeem**
  (recurrence-engine genereert taakinstanties per klant), **de wettelijke
  kalender** (deadlines die jaarlijks kunnen verschuiven), **medewerkers**
  (handmatig aanmaken/herverdelen/annoteren).

## §0 — Wat overleeft uit de vorige (generieke kanban) build, wat niet

**Herbruikbaar (patronen/infrastructuur, niet het datamodel):**
- `src/lib/supabase.ts` — client-setup blijft.
- Auth-patroon (`useAuth`/`AuthPage`) — Supabase Auth blijft, maar moet
  gekoppeld worden aan een `employees`-profiel (auth.users → medewerker →
  kantoor/firm) i.p.v. een geïsoleerd persoonlijk board.
- RLS-*patroon* van geneste `exists`-subqueries via parent-ownership (zie
  `0002_rls_fixes.sql`) — techniek bruikbaar, predicaat verschuift van "rij
  is van mij" naar "rij hoort bij mijn kantoor" (en voor `clients`: naar
  `can_view_client()`, zie §2.9).
- UI-bouwstenen: `Modal.tsx`, `EmptyState.tsx`, `ErrorState.tsx`,
  `Skeletons.tsx`, `LabelBadge.tsx` (wordt status/verplichtingtype-badge).
- Testopzet: vitest + `supabaseMock.ts`.

**Vervangen (niet geschikt voor dit domein) — nieuwe migraties 0003+,
0001/0002 blijven staan als historie maar hun schema wordt niet meer
gebruikt:**
- Het hele datamodel `boards/columns/labels/tasks/task_labels` en de
  bijhorende RLS (`user_id = auth.uid()` als enige tenant-grens).
- `useBoardData.ts` — laadt alles client-side voor "mijn ene board"; nieuwe
  hooks moeten server-side filteren (per klant/medewerker/periode).
- `Board.tsx`/`BoardColumn.tsx` als hoofdscherm — het kanbanbord is hier
  niet de primaire interface (zie §4); mag als secundair widget overleven
  binnen een klant-/lijstweergave, niet als startscherm.
- De signup-trigger die automatisch "My Board" + 3 kolommen aanmaakt —
  vervangen door kantoor/medewerker-onboarding (invite-only, zie §7).

## §1 — Scope v1 vs. later

**v1 (bouwen nu):**
- Kantoor (`firms`) + medewerkers + rollen (medewerker/kantoorbeheerder) +
  losse `mag_goedkeuren`-vlag.
- Klantenbeheer: rechtsvorm, boekjaareinde, `btw_regime`, mandataris,
  vertrouwelijk, actief, standaard verantwoordelijke (verplicht bij
  vertrouwelijke klanten).
- Catalogus van 8 verplichtingtypes (§2.3), per klant configureerbaar
  (`client_obligations`, effectief-gedateerd).
- Wettelijke kalender (`legal_calendar`) + feestdagenkalender
  (`public_holidays`), door kantoorbeheerder jaarlijks bijgewerkt.
- Recurrence-engine met rollende horizon (2-3 maanden vooruit).
- Toewijzing (1 verantwoordelijke per taakinstantie, default afgeleid van
  klant/verplichting), statusflow inclusief goedkeuringsstap (§2.7),
  dynamisch berekende escalatie/overdue.
- Volledig audittrail (`task_status_log`), altijd een echte medewerker als
  actor, nooit "systeem".
- Kernviews (§4): Mijn taken, Werklijst, Klantdossier, Kalenderweergave,
  Escalatie-queue, Workload-dashboard, Wettelijke-kalenderbeheer,
  Klantenlijst.
- Firm-scoped RLS + `can_view_client()`-mechanisme voor vertrouwelijke
  klanten (§2.9).

**Expliciet later (niet nu bouwen):**
- Klantportaal, integraties (Intervat/Biztax/NBB-loket/e-invoicing),
  e-mail/push-notificaties, documentbeheer/bijlagen,
  tijdregistratie/facturatie, zelf-gedefinieerde verplichtingtypes,
  doorlooptijd-analytics, meertaligheid (v1 = NL-only UI), multi-office.

## §2 — Datamodel (concreet genoeg om te implementeren)

### 2.1 `firms`
`id, naam, created_at`

### 2.2 `employees`
`id, firm_id, auth_user_id (FK auth.users), naam, rol enum('medewerker','kantoorbeheerder'), mag_goedkeuren boolean not null default false, actief boolean not null default true, created_at`

### 2.3 `clients`
`id, firm_id, naam, ondernemingsnummer, rechtsvorm, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime enum('geen','periodieke_aangever','vrijgesteld_kleine_onderneming') not null default 'geen', btw_aangifte_frequentie enum('maand','kwartaal') — check constraint: alleen ingevuld wanneer btw_regime='periodieke_aangever', anders null, mandataris boolean, vertrouwelijk boolean not null default false, standaard_verantwoordelijke_id FK employees — **check constraint: verplicht (not null) wanneer vertrouwelijk = true**, actief boolean not null default true, created_at`

Trigger: bij update van `btw_regime` op `clients` automatisch de
gekoppelde `client_obligations`-rijen voor BTW-aangifte en
BTW-klantenlisting activeren/deactiveren (nooit verwijderen).

### 2.4 `obligation_types` (vaste catalogus, 8 rijen, seed-data in de migratie)
`id, code, naam, categorie enum('wettelijk','service'), deadline_mechanisme enum('formule','boekjaar_relatief','jaarlijkse_kalender','afgeleid_van_gebeurtenis'), standaard_periodiciteit`

Zie §2.5 voor de 8 rijen en hun mechanisme.

### 2.5 De 8 verplichtingtypes

| Code | Naam | Categorie | Mechanisme | Berekening |
|---|---|---|---|---|
| `btw_aangifte` | BTW-aangifte | wettelijk | formule | 20e van de maand na de periode (maand/kwartaal per klant) |
| `va_venb` | Voorafbetaling VenB (VA1–VA4) | wettelijk | boekjaar_relatief | 4x per boekjaar, kwartaaldeadlines t.o.v. boekjaareinde |
| `jaarafsluiting` | Jaarafsluiting | wettelijk | boekjaar_relatief | Kantoor-SLA (configureerbaar aantal maanden na boekjaareinde), voorloper voor AV/aangifte |
| `algemene_vergadering` | Algemene vergadering | wettelijk | boekjaar_relatief | Wettelijk binnen 6 maanden na boekjaareinde |
| `neerlegging_jaarrekening` | Neerlegging jaarrekening (NBB) | wettelijk | afgeleid_van_gebeurtenis | 30 dagen na effectieve afronding van de AV-taak; vóór afronding: voorlopige due_date o.b.v. geplande AV-datum (`voorlopige_datum=true`) |
| `aangifte_venb_pb` | Aangifte VenB / PB | wettelijk | jaarlijkse_kalender | Campagnedatum uit `legal_calendar`, gesegmenteerd op boekjaar-eindmaand voor VenB |
| `rapportering` | Periodieke rapportering naar klant | service | formule | Interval per klantcontract (`client_obligations.parameters`) |
| `btw_klantenlisting` | BTW-klantenlisting | wettelijk | formule | Jaarlijks, 31 maart, voor elke klant met `btw_regime != 'geen'` |

### 2.6 `client_obligations`
`id, client_id, obligation_type_id, actief boolean, geldig_vanaf date, geldig_tot date (nullable), parameters jsonb (bv. periodiciteit, rapportage_frequentie, va_optimalisatie_gewenst), standaard_toegewezen_medewerker_id FK employees (nullable, default valt terug op clients.standaard_verantwoordelijke_id)`

Effectief-gedateerd: een wijziging (bv. BTW-frequentie) sluit de oude rij
af (`geldig_tot`) en opent een nieuwe, i.p.v. de bestaande rij te
overschrijven — zodat oude periodes hun oorspronkelijke parameters
behouden.

### 2.7 `task_instances`

Statusflow: `open → in_uitvoering → wacht_op_klant → wacht_op_goedkeuring (enkel wanneer vereist_goedkeuring=true) → ingediend_afgerond`, plus `geannuleerd` vanuit elke status, plus expliciete terugkeer `wacht_op_goedkeuring → in_uitvoering` (afkeuring).

Velden: `id, client_id, obligation_type_id (nullable — null bij ad-hoc), client_obligation_id (nullable), periode_label, periode_start, periode_eind, due_date (effectief, na verschuiving), due_date_wettelijk (ruw, vóór verschuiving), due_date_verschoven boolean (afgeleid), status, toegewezen_medewerker_id FK employees, voorloper_taak_id (self-FK, voor neerlegging→AV), bron_type enum('automatisch_gegenereerd','handmatig_adhoc'), voorlopige_datum boolean, vereist_goedkeuring boolean not null default false — **bevroren op aanmaakmoment vanuit obligation_types.categorie='wettelijk', niet live herberekend**, goedgekeurd_door FK employees (nullable), goedgekeurd_op timestamptz, review_vereist boolean not null default false, review_reden text, title text (verplicht bij ad-hoc, anders afgeleid van obligation_type), description text, afgerond_op timestamptz, created_at, updated_at`

Uniek per (`client_id, obligation_type_id, periode_label`) voor
automatisch gegenereerde instanties — idempotentie bij herhaalde
generatie-runs.

**Ad-hoc taken** (§3.5): `obligation_type_id` en `client_obligation_id`
null, `bron_type='handmatig_adhoc'`, `client_id` blijft verplicht, vrije
`title`, handmatig gekozen `due_date`, geen recurrence, geen
`review_vereist`-logica, `vereist_goedkeuring` altijd `false`.

### 2.8 `task_status_log` (algemeen event-log, niet enkel statusovergangen)
`id, task_instance_id FK, event_type enum('status_wijziging','due_date_herberekend','toewijzing_gewijzigd','review_gemarkeerd','review_afgehandeld','goedkeuring_gegeven','goedkeuring_geweigerd'), oud_status/nieuw_status (nullable), oude_due_date/nieuwe_due_date (nullable), actor_employee_id FK employees not null (nooit "systeem"), trigger_bron enum('medewerker_actie','kalender_herberekening','av_opvolging_automatisch'), notitie text, created_at`

Bij kalender-herberekening: actor = `aangemaakt_door`/`gewijzigd_door` van
de betreffende `legal_calendar`/`public_holidays`-rij. Bij AV→neerlegging:
actor = de medewerker die de AV-taak afrondde.

### 2.9 `legal_calendar`
`id, obligation_type_id, jaar/periode, scope (bv. boekjaar-eindmaand-groep), deadline_datum, is_override boolean, bron/publicatiedatum, aangemaakt_door FK employees not null, gewijzigd_door FK employees not null, updated_at`

### 2.10 `public_holidays`
`id, jaar int, datum date, omschrijving text, aangemaakt_door/gewijzigd_door FK employees not null, unique(datum)`

Door kantoorbeheerder jaarlijks aangevuld — bewust geen hardcoded lijst.

**Geaccepteerd restrisico (security-review, migratie 0008):** `legal_calendar`
en `public_holidays` zijn bewust gedeeld/niet firm-scoped — elke
kantoorbeheerder op deze instance kan de wettelijke kalender/feestdagen
wijzigen, met impact op de gegenereerde taakinstanties van ALLE kantoren op
de instance, niet enkel het eigen kantoor. Dit is een bewuste ontwerpkeuze
(gedeelde nationale referentiedata, geen concurrentiegevoelige klantdata),
geen bug — zie ook de tabel-comments in 0008.

### 2.11 Vertrouwelijkheid & zichtbaarheid — `can_view_client()`

```sql
create or replace function public.can_view_client(p_client_id uuid, p_employee_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    not c.vertrouwelijk
    or e.rol = 'kantoorbeheerder'
    or exists (
      select 1 from task_instances ti
      where ti.client_id = p_client_id
        and ti.toegewezen_medewerker_id = p_employee_id
        and ti.status <> 'geannuleerd'
    )
  from clients c, employees e
  where c.id = p_client_id and e.id = p_employee_id;
$$;
```

Gebruikt in RLS-policies op `clients`, `task_instances` en alle
klant-gebonden tabellen. Ondersteunende index:
`create index on task_instances(client_id, toegewezen_medewerker_id) where status <> 'geannuleerd';`

Bij generatie van een nieuwe instantie voor een vertrouwelijke klant:
engine wijst standaard toe aan `clients.standaard_verantwoordelijke_id`
(nu verplicht ingevuld, zie §2.3) zodat er nooit een onzichtbare
niet-toegewezen taak voor een vertrouwelijke klant ontstaat.

## §3 — Recurrence- en kalendermechaniek

1. **Due-date-pipeline**: ruwe datum bepalen (formule / campagnedatum /
   afgeleid) → `next_business_day()` toepassen (iteratief doorschuiven bij
   weekend of `public_holidays`-datum) → opslaan als `due_date` +
   `due_date_wettelijk` + `due_date_verschoven`. Uniform toegepast, ook op
   campagnedata (no-op maar consistente pipeline).
2. **Generatie**: rollende horizon (2-3 maanden vooruit) per actieve
   `client_obligation`, idempotent op (`client_id, obligation_type_id,
   periode_label`). Primair mechanisme: geplande job (Supabase Edge
   Function op cron als die haalbaar is binnen deze build; anders een
   expliciete "genereer nu"-actie voor de kantoorbeheerder als
   fallback/MVP — er is geen bestaande cron-infra in de repo, dus dit is
   nieuw te bouwen. On-demand-bij-inloggen is **niet** het primaire
   mechanisme (fragiel voor een compliance-tool).
3. **Mid-jaar wijziging**: bij aanpassing van een `client_obligations`-
   parameter met al bestaande toekomstige/open instanties: die instanties
   krijgen `review_vereist=true` + leesbare `review_reden`, filterbaar in
   de werklijst. Bij afhandeling: reset naar `false` + `review_afgehandeld`
   gelogd.
4. **Kalendercorrectie**: nieuwe `legal_calendar`/`public_holidays`-rij met
   `is_override=true` herberekent `due_date` op alle instanties met
   `status='open'` die ernaar verwijzen (niet instanties die al in
   behandeling zijn). Elke herberekening gelogd (`due_date_herberekend`,
   traceerbare actor).
5. **AV → neerlegging**: bij afronding van de AV-taak (effectieve datum)
   herberekent de gekoppelde neerlegging-instantie haar `due_date` (+30
   dagen, door dezelfde verschuivingsstap), zet `voorlopige_datum=false`,
   logt met actor = de medewerker die de AV-taak afrondde.
6. **Offboarding**: `before update`-trigger op `employees.actief`
   (true→false): blokkeert (exception) zolang er `task_instances` bestaan
   met `toegewezen_medewerker_id` = deze medewerker en status niet in
   (`ingediend_afgerond`, `geannuleerd`) — dus ook `wacht_op_goedkeuring` en
   `wacht_op_klant` blokkeren. UI-flow: eerst bulk-herverdelen, dan pas
   deactiveren lukt.
7. **Onderhoud van de wettelijke kalender**: bewust handmatig door de
   kantoorbeheerder (nooit hardcoded), voor zowel `legal_calendar` als
   `public_holidays`.

**Te verifiëren vóór productiegebruik met échte klantdata (bouw nu wél met
deze aannames als veilige default):**
- Schuift FOD in de praktijk zelf al automatisch door bij weekend/feestdag
  (dan telt onze verschuiving dubbel), of is dit een interne werkregel?
  `due_date_wettelijk` blijft bewaard zodat dit achteraf corrigeerbaar is.
- VA1-VA4 als formule (i.p.v. jaarlijkse kalender) — waarschijnlijk correct,
  fiscale bevestiging gewenst.
- BTW-klantenlisting bij `vrijgesteld_kleine_onderneming` — mechanisme
  genereert nu voor `btw_regime != 'geen'`; mogelijk moet dit verfijnd
  worden per regime. Aanpassing = predicaat wijzigen, geen schema-wijziging.

## §4 — Werkschermen (geen kanbanbord als hoofdscherm)

1. **Mijn taken (vandaag/deze week)** — persoonlijke, cross-klant
   werklijst op urgentie, filters op type/status.
2. **Werklijst** (tabel, primair dagelijks werkscherm) — filterbaar/
   sorteerbaar op klant/type/status/medewerker/deadline, "te laat eerst",
   bulkacties (herverdelen, status).
3. **Klantdossier** — alle verplichtingen, status/historiek, komende
   deadlines, verantwoordelijke, notities per klant.
4. **Kalender-/tijdlijnweergave** — maand/kwartaal, deadline-dichtheid,
   per medewerker of kantoorbreed.
5. **Escalatie-/overdue-queue** — te laat/naderend zonder actie, op
   ernst gesorteerd. Wettelijke verplichtingen krijgen strengere/eerdere
   urgentiebanden dan service-rapportering.
6. **Workload-dashboard** (kantoorbeheerder/partner) — capaciteit per
   medewerker, aantal te laat, verwacht volume.
7. **Wettelijke-kalenderbeheer** (adminscherm) — jaarlijkse campagnedata +
   feestdagen invoeren/corrigeren, met zichtbare historie van overrides.
8. **Klantenlijst/zoekscherm** — zoeken/filteren over alle klanten op
   rechtsvorm, boekjaareinde, mandataris, actief, verantwoordelijke.

## §5 — Rollen & rechten (RLS-samenvatting)

- Twee rollen: `medewerker`, `kantoorbeheerder`, plus onafhankelijke
  `mag_goedkeuren`-vlag.
- Firm-scoped RLS op alle tabellen (rij hoort bij mijn `firm_id`).
- `clients`/`task_instances`/klant-gebonden data: extra gefilterd via
  `can_view_client()` (§2.11) voor vertrouwelijke klanten.
- Kantoorbeheerder: volledige zichtbaarheid altijd, kan medewerkers
  beheren, wettelijke kalender bewerken, deactiveren (met
  herverdeel-blokkade).
- Goedkeuring: alleen medewerkers met `mag_goedkeuren=true` kunnen een
  taak van `wacht_op_goedkeuring` naar `ingediend_afgerond` zetten (of
  terugsturen). Zelf-goedkeuring is **technisch toegelaten**, maar de UI
  toont een duidelijke waarschuwing wanneer `goedgekeurd_door =
  toegewezen_medewerker_id`.

## §6 — Onboarding/provisioning

Invite-only als v1-default (B2B-tool met gevoelige klantdata): een kantoor
wordt vooraf aangemaakt (of door de eerste gebruiker die zich registreert,
die dan automatisch kantoorbeheerder wordt — kies de eenvoudigste optie om
te bouwen: self-serve eerste-gebruiker-wordt-kantoorbeheerder, met
nadien invite-only voor collega's, tenzij dit een aparte
uitnodigingsflow te veel complexiteit toevoegt voor v1 — beslis dit
pragmatisch en documenteer de keuze in je samenvatting).

## §7 — Beslissingenlog (definitief, niet meer ter discussie)

1. **Zichtbaarheid**: volledige zichtbaarheid als default; vertrouwelijke
   klanten zijn de uitzondering via `can_view_client()` (§2.11).
2. **Goedkeuringsstap**: toegevoegd aan de statusflow, enkel voor
   categorie "wettelijk", bewaakt via `mag_goedkeuren` (geen aparte rol).
3. **Four-eyes**: toegestaan met waarschuwing, geen harde blokkade.
4. **Vertrouwelijke klant ⇒ verplichte standaard verantwoordelijke**: harde
   constraint, voorkomt onzichtbare niet-toegewezen taken.

## Belangrijk voor de developer-agent

- Dit is een grote build. Prioriteit: datamodel + RLS + recurrence-engine
  correct (dit is het compliance-kritische deel), dan de kernviews uit §4
  (Werklijst en Klantdossier eerst als primaire schermen, daarna Mijn
  taken/Kalender/Escalatie/Workload/Kalenderbeheer/Klantenlijst). Als tijd
  beperkt is: lever een werkende, correcte basis op één view minder liever
  dan overal een halfwerkende versie — en meld expliciet wat nog ontbreekt.
- Seed de `obligation_types`-tabel met de 8 rijen uit §2.5 in de migratie
  zelf (vaste catalogus, geen UI nodig om ze aan te maken in v1).
- Voeg wat testdata toe (een paar voorbeeldklanten met verschillende
  `btw_regime`/boekjaareinde) zodat de UI met realistische data te
  bekijken is, maar maak dit duidelijk herkenbaar als seed/demo-data.

## §8 — Beslissing: single-tenant (2026-08-25)

Taskflow draait voor **één kantoor** — dat van de gebruiker. Andere kantoren
komen niet op deze instance. Meerdere *teams binnen* dat kantoor is een
mogelijke latere uitbreiding, andere kantoren niet.

Gevolgen voor het ontwerp:

- Het gedeelde karakter van `legal_calendar` en `public_holidays` (§2.9/§2.10)
  is hiermee geen risico meer: er is maar één kantoor dat ze onderhoudt. De
  firm-scoping van die tabellen die de security-review als optie opperde,
  wordt daarom **niet** gebouwd.
- De voorwaarde daarvoor is wel hard: **self-serve registratie moet dicht**
  (Supabase → Authentication → "Allow new users to sign up" uit). Zolang die
  openstaat en de site publiek bereikbaar is, kan een buitenstaander een
  eigen kantoor aanmaken en via de gedeelde kalender de deadlines van de
  echte klanten verschuiven — dat is end-to-end gereproduceerd in de
  security-review van 2026-08-25.
- Het multi-tenant datamodel (`firms` + firm-scoped RLS) blijft staan zoals
  het is. Het is nu effectief single-tenant, maar niets moet worden
  afgebroken; als teams later toch een eigen afscherming nodig hebben, is de
  bestaande firm-grens het natuurlijke aanknopingspunt.
- De rest van de bevindingen uit die review (goedkeuringsstap omzeilbaar,
  deadlines ongelogd wijzigbaar, feestdagcorrectie zonder herberekening,
  ongeaudite klantwijzigingen) blijft onverminderd gelden: die gaan over de
  eigen medewerkers en over de integriteit van het audittrail, niet over
  vreemde kantoren.

## §9 — Bevestigde fiscale regels (door het kantoor, augustus 2026)

Deze punten stonden als aanname in de motor en zijn nu bevestigd of
gecorrigeerd door Wibren. Ze staan hier zodat een latere lezer ze niet per
ongeluk terugdraait.

**BTW-aangifte.** Maandaangifte: de 20ste van de maand na de periode.
Kwartaalaangifte: de 25ste van de maand na het kwartaal. De motor rekende voor
beide de 20ste — gecorrigeerd in migratie 0017, inclusief herstel van de al
gegenereerde rijen.

**Werkdagverschuiving.** Een btw-deadline die op een zaterdag, zondag of
feestdag valt, schuift door naar de eerstvolgende werkdag. Dat geldt voor
maand- én kwartaalaangiften. De maand/kwartaal-splitsing en de
overgangsregelingen uit de hervorming van de btw-ketting worden bewust NIET
gemodelleerd: "hou geen rekening met speciale maatregelen". Eenmalige
verlengingen (zoals de listing over 2025 tot 30 april 2026) horen in
`legal_calendar` als override, niet in de formule.

**Voorafbetalingen.** 10/4, 10/7, 10/10 en 20/12 bij een afsluiting per 31/12,
en meeschuivend wanneer het boekjaar op 31/3, 30/6 of 30/9 eindigt. De motor
rekent sinds 0017 terug vanaf de maand van het boekjaareinde (−8, −5, −2 en 0
maanden) in plaats van vooruit vanaf het begin; voor een boekjaar van twaalf
maanden levert dat identieke data op, maar het blijft ook kloppen als het
boekjaar dat niet is. **Er is geen vijfde voorafbetaling** — VA1–VA4 is
volledig.

**BTW-klantenlisting.** Ook de vrijgestelde kleine onderneming (art. 56bis)
moet haar klantenlisting doorsturen, met vermelding van de omzet. De regel
`btw_regime <> 'geen'` is dus correct en blijft.
