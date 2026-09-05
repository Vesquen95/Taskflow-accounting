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
  vertrouwelijke klanten). De kolom `mandataris` heet op het scherm en in
  het importsjabloon "Fiscaal mandaat"; de kolomnaam in de databank bleef
  ongewijzigd.
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
- Kernviews (§4): Kalenderweergave (hoofdscherm), de vijf werkstromen
  (§10), Klantdossier, Workload-dashboard, Wettelijke-kalenderbeheer,
  Klantenlijst. (Mijn taken, Werklijst en de Escalatie-queue zijn er
  geweest en zijn in augustus 2026 vervallen — zie §4.)
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
   krijgen `review_vereist=true` + leesbare `review_reden`. De taak draagt
   in elke lijst een zichtbaar "review"-merkteken; het aparte filter erop
   verdween met de werklijst (§4). Bij afhandeling: reset naar `false` +
   `review_afgehandeld` gelogd.
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

**Bijgewerkt augustus 2026, beslist met het kantoor.** De punten 1, 2 en 5
zijn vervallen en gebouwd-en-weer-verwijderd; punt 4 (de kalender) is het
hoofdscherm geworden. De nummering blijft bewust staan — code en tests
verwijzen ernaar ("§4 point 3"), en een vervallen punt is nuttiger dan een
verschoven nummer. Wat er staat is dus de huidige opzet, niet de
oorspronkelijke.

1. ~~**Mijn taken (vandaag/deze week)**~~ — **vervallen (augustus 2026).**
   Een werkstroom met het medewerkersfilter op jezelf toont hetzelfde, en
   dan binnen het werk dat je op dat moment aan het doen bent. Een apart
   scherm ernaast betekende twee plekken waar dezelfde taak kon opduiken.
2. ~~**Werklijst** (tabel, primair dagelijks werkscherm)~~ — **vervallen
   (augustus 2026).** Eén kantoorbrede lijst over alle verplichtingstypes
   heen is bij ~100 dossiers onwerkbaar: je scrolt door honderden regels
   voor je bij het werk van vandaag komt. Dat is precies waarom de
   werkstromen (§10) er kwamen; die zijn nu de enige takenlijst, mét de
   bulkacties en de doorklikbare status die hier stonden.
3. **Klantdossier** — alle verplichtingen, status/historiek, komende
   deadlines, verantwoordelijke, notities per klant.
4. **Kalender-/tijdlijnweergave** — maand/kwartaal, deadline-dichtheid,
   per medewerker of kantoorbreed. **Sinds augustus 2026 het hoofdscherm**:
   de landingspagina na inloggen, en de terugval voor elke onbekende of
   niet-toegelaten route. Het is bewust een overzichtsscherm — afwerken
   gebeurt in de werkstromen.
5. ~~**Escalatie-/overdue-queue**~~ — **vervallen (augustus 2026).** De
   achterstand staat nu als blok **"Te laat"** bovenaan élke werkstroom, in
   elk deadlinevenster (§10). Je ziet je achterstand dus in het scherm waar
   je hem wegwerkt, in plaats van in een aparte lijst die je apart moest
   opzoeken. De strengere/eerdere urgentiebanden voor wettelijke
   verplichtingen t.o.v. service-rapportering blijven bestaan
   (`src/lib/urgency.ts`) en kleuren de badges in elke lijst.
6. **Workload-dashboard** (kantoorbeheerder/partner) — capaciteit per
   medewerker, aantal te laat, verwacht volume.
7. **Wettelijke-kalenderbeheer** (adminscherm) — jaarlijkse campagnedata +
   feestdagen invoeren/corrigeren, met zichtbare historie van overrides.
8. **Klantenlijst/zoekscherm** — zoeken/filteren over alle klanten op
   rechtsvorm, boekjaareinde, mandataris, actief, verantwoordelijke.

### Waar de status doorklikbaar is, en waar niet

Op de werkschermen (de vijf werkstromen) is de status een knop: één klik zet de
taak naar de volgende stap. Dat is waar het kantoor taken afwerkt, blok per blok.

Op de **kalender** en in het **klantdossier** blijft de status een label
(beslist met het kantoor, augustus 2026). Dat zijn overzichtsschermen: je kijkt
daar naar de spreiding van deadlines of naar de historiek van één dossier, niet
naar wat je nu moet afvinken. Een knop op een plek waar je alleen leest nodigt
uit tot een klik die je niet bedoelde. Wie daar toch iets wil wijzigen, opent de
taak; het detailvenster toont de juiste keuzes.

Aanpassen hoort dus niet "voor de consistentie" alsnog te gebeuren. Ook niet nu
de kalender het hoofdscherm is: dat verandert waar je binnenkomt, niet waarvoor
het scherm dient.

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
  taken/Kalender/Escalatie/Workload/Kalenderbeheer/Klantenlijst — deze
  volgorde is de opzet van de eerste build; Werklijst/Mijn taken/Escalatie
  bestaan niet meer, zie §4). Als tijd
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

**Werkdagverschuiving.** ~~Een btw-deadline die op een zaterdag, zondag of
feestdag valt, schuift door naar de eerstvolgende werkdag. Dat geldt voor
maand- én kwartaalaangiften.~~ **Achterhaald sinds 04/09/2026 — zie §12.**
Voor maandaangevers klopt dit nog; voor kwartaalaangevers en voor de
bijzondere aangifte is de tolerantie afgeschaft. De maand/kwartaal-splitsing en de
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

## §10 — Werkstromen en taakgeneratie (beslist met het kantoor, augustus 2026)

### Werkstromen

Taken worden gegroepeerd in vijf werkstromen. Het kantoor werkt per blok, niet
per klant: "deze week alle btw-aangiftes". De stroom is een kolom op
`obligation_types`, niet iets in de schermcode, zodat een nieuw
verplichtingstype vanzelf ergens thuishoort.

| Werkstroom | Verplichtingstypes |
|---|---|
| Btw | btw_aangifte, btw_klantenlisting |
| Afsluiting | jaarafsluiting, algemene_vergadering, neerlegging_jaarrekening |
| Vennootschapsbelasting | va_venb, aangifte_venb_pb |
| Rapportering | rapportering |
| Ad-hoc | taken zonder verplichtingstype |

Rapportering staat bewust apart en niet bij Afsluiting: het is het enige type
met categorie `service`, zonder wettelijke deadline en zonder goedkeuringsstap.
Het samenvoegen zou de emmer vervuilen waar het kantoor juist op wil kunnen
vertrouwen.

**Filteren gebeurt op deadlinevenster, niet op periode.** De maandaangifte van
maart (20/04) en de kwartaalaangifte Q1 (27/04) zijn één campagne in dezelfde
week, maar dragen verschillende periodelabels. Op periode filteren zou de helft
van de stapel verbergen.

**Gebouwd (migratie 0022 + `src/lib/werkstromen.ts`).** Elke werkstroom heeft
een eigen ingang in de zijbalk, onder de kop "Werk". Per ingang:

- Een keuze uit vijf deadlinevensters: deze week, deze maand, volgende maand,
  dit kwartaal, alles. Het venster heeft alleen een bovengrens — **geen**
  ondergrens: wat te laat is hoort in élk venster thuis, anders raak je
  achterstand kwijt zodra je inzoomt op deze week. "Volgende maand" betekent
  dus "tot en met het einde van volgende maand", niet "alleen volgende maand";
  de filterbalk zegt dat er ook bij. "Alles" blijft als laatste keuze staan,
  want zonder die keuze kan je het geheel niet meer overzien.
- De taken staan in blokken per deadline**maand**, met de bulkacties per blok,
  en binnen een blok chronologisch op deadline. Kop: "september 2026" — het
  jaartal moet erbij, want met "Alles" loopt de lijst tot 2029.
- Blokken per dag (de eerste versie) zijn vervangen na gebruik door het
  kantoor: bij een venster van een kwartaal gaf dat tientallen blokjes van één
  regel, en de blokkop herhaalde de datum die al per regel in de kolom Deadline
  staat. De exacte dag staat dus nog op één plek, naast de urgentiebadge.
- Alles wat te laat is staat als één blok bovenaan, niet uitgesmeerd over losse
  maanden: achterstand pak je als geheel aan.

**Augustus 2026:** de brede lijsten Werklijst, Mijn taken en Escalatie-queue
zijn verwijderd (§4). De werkstromen zijn de enige takenlijst; de kop
"Overzicht" in de zijbalk is daarmee verdwenen. De kalender staat als
hoofdscherm bovenaan de zijbalk, zonder tussenkop — een kop boven één item
leest als een categorie waar nog iets bij hoort.

### De feestdagenkalender loopt voor op de horizon

De motor genereert 36 maanden vooruit. Loopt `public_holidays` korter, dan
verschuift hij voorbij dat jaar alleen nog op weekends en niet meer op
feestdagen. Dat is in productie gebeurd: een algemene vergadering met wettelijke
datum 30/12/2028 (zaterdag) schoof naar **1 januari 2029** -- Nieuwjaar -- omdat
2029 niet in de tabel stond.

Beslist (migratie 0023):

- De vier bewegelijke feestdagen worden **gerekend** vanuit Pasen (anonieme
  gregoriaanse computus), niet jaar per jaar overgetypt. Een tikfout in een
  overgetypte lijst is onzichtbaar tot er een deadline op de verkeerde dag valt.
- `laad_feestdagen(van, tot)` schuift de kalender vooruit; voorbehouden aan de
  kantoorbeheerder, want elke invoeging herberekent de deadlines van het hele
  kantoor.
- Het beheerscherm **waarschuwt** zodra de dekking onder de horizon zakt, met
  een knop om ruim over de horizon heen aan te vullen. Bewust een waarschuwing
  en geen blokkade op de generatie: blokkeren zou terecht zijn maar breekt het
  werk midden in de dag, terwijl de waarschuwing komt voor het misgaat.
- Alleen **volledige** jaargangen (tien feestdagen) tellen als gedekt. Een losse
  feestdag in een ver jaar mag niet doorgaan voor "dat jaar is in orde".

### De horizon schuift vanzelf mee

Op 27/08/2026 bleken er kantoorbreed 182 taken te ontbreken: de generatie had
sinds de eerste opzet nooit meer gedraaid, dus de horizon liep tot november 2026
in plaats van 36 maanden vooruit. Dat kwam pas aan het licht toen het kantoor bij
toeval naar een dossier keek waar een taak miste.

Beslist (migratie 0025): een maandelijkse job (`pg_cron`, de 1e om 03:00 UTC)
vult eerst de feestdagenkalender aan en genereert daarna per kantoor opnieuw.
Die volgorde is niet vrijblijvend -- andersom worden deadlines berekend tegen een
kalender die de laatste jaren nog niet kent.

**Het mag niet stil gebeuren.** Elke ronde laat een rij na in `onderhoud_log`, en
het beheerscherm toont de laatste stand. Een mislukte ronde werpt bewust *geen*
fout op naar buiten: dat zou de transactie terugdraaien en juist de logregel
wissen die de mislukking vastlegt (Postgres kent geen autonome transactie). Het
logboek is dus de enige plek waar een storing zichtbaar wordt, en het scherm zet
ze daarom in het rood.

### Kalenderjaar versus boekjaar

Btw loopt per kalenderjaar, de rest per boekjaar. Verwarrend maar zo is het, en
zo staat het in de motor:

| Loopt op | Verplichtingen |
|---|---|
| kalendermaand / -kwartaal / -jaar | btw_aangifte, btw_klantenlisting, rapportering |
| boekjaar | va_venb, jaarafsluiting, algemene_vergadering, neerlegging_jaarrekening, aangifte_venb_pb |

### Rekenregels

| Verplichting | Regel |
|---|---|
| Btw-aangifte | maand: de 20ste; kwartaal: de 25ste van de maand na de periode |
| Btw-klantenlisting | 31/03 van het volgende kalenderjaar, ook voor art. 56bis |
| Voorafbetaling | teruggerekend vanaf de maand van het boekjaareinde: −8, −5, −2 en 0 maanden, dagen 10/10/10/20 |
| Aangifte VenB/PB | laatste dag van de 7de maand na het boekjaareinde |
| Jaarafsluiting | boekjaareinde + `sla_maanden` (standaard 3), per klant aanpasbaar |
| Algemene vergadering | de statutaire datum, per klant ingevuld (zie hieronder) |
| Neerlegging jaarrekening | AV + 30 dagen |
| Rapportering | per periode + `termijn_dagen` (standaard 10), per klant aanpasbaar |

De wettelijke kalender is voor de aangifte VenB/PB een **override**, geen
voorwaarde. Vóór deze beslissing werd de datum uitsluitend daar opgezocht: geen
kalenderrij betekende geen taak, zonder enige melding — een deadline die
nergens bestond. Nu rekent de motor zelf en wint een ingevulde campagnedatum.

### De algemene vergadering

De AV-datum staat in de statuten en wordt per klant ingevuld. Twee vormen, beide
komen voor:

* een **vaste datum** — "1 april"
* een **n-de weekdag** — "de eerste maandag van april"

De datum wordt gelezen als de eerstvolgende gelegenheid ná het boekjaareinde, en
moet binnen zes maanden daarna vallen. Een combinatie die daarbuiten valt wordt
geweigerd bij het invullen, niet stilzwijgend tot een onwettige datum verwerkt.

Wijzigen de statuten, dan **schuift alles mee**: de open toekomstige AV-taken en
de neerleggingen die eraan hangen worden herrekend. Dat is een zeldzame,
eenmalige handeling en mag dus zwaar zijn.

### Geen taken in het verleden

Bij het aanmaken van een klant werden acht van de tien taken met een deadline in
het verleden aangemaakt: de motor begrensde alles met één globaal venster
(`vandaag − backfill`), gelijk voor een dossier van tien jaar oud en een van
vanmorgen. Bij ~100 dossiers is dat honderden regels ruis.

De ondergrens wordt `client_obligations.geldig_vanaf`. **De grens ligt op de
deadline, niet op de periode**: neem je een klant over op 20 juli, dan valt de
btw-aangifte van Q2 (deadline 27/07) er nog binnen — die moet het kantoor
indienen, ook al ligt de periode zelf achter ons. Blijkt zo'n grensgeval toch
niet nodig, dan wordt hij geannuleerd.

### Verplichtingen wijzigen

Verplichtingen bij- of afzetten gebeurt bij het **opslaan van de klant**, niet
via een aparte generatieknop. Een verplichting toevoegen maakt meteen haar
toekomstige taken aan; een verplichting afsluiten annuleert haar open,
toekomstige taken. Wat in uitvoering of ingediend is blijft staan — dat is werk
dat gebeurd is.

Verwijderen bestaat niet en komt er niet: annuleren haalt de taak uit alle
lijsten en houdt hem in de geschiedenis van het dossier.

De batchgeneratie blijft bestaan voor één doel: de horizon opschuiven wanneer er
een nieuw kwartaal bijkomt. Dat heeft niets met een klantwijziging te maken.

### Buiten scope voor nu

Eenmanszaken (enkel personenbelasting, geen AV, geen neerlegging). De
voorafbetalingen voor starters blijven wél gegenereerd, ook al zijn kleine
vennootschappen de eerste drie boekjaren niet verplicht: ze zijn een aanleiding
om erover na te denken.

## §11 — Wat er sinds §10 beslist en gebouwd is (september 2026)

§8 noemde meerdere teams binnen het kantoor nog "een mogelijke latere
uitbreiding", en de slotparagraaf van §10 zette eenmanszaken buiten scope.
Allebei achterhaald. Deze sectie houdt bij wat er sindsdien beslist is, zodat
een latere lezer — of een agent die dit bestand als bron gebruikt — niet op
een verouderd plan verder bouwt.

**Teams (0038–0039).** Het kantoor werkt in teams: AAL, ZAV1, ZAV2, ZAV3, ANT
en GOS. Een medewerker kan in meerdere teams zitten. Dossiers horen bij één
team, en een team ziet de dossiers van een ander team niet — de afscherming
zit in de databank (`mag_klant_zien`), niet in het scherm. ZAV1/2/3 staan los
van elkaar. Werk zonder naam blijft in de bak van het team staan
(`toegewezen_medewerker_id is null`), zichtbaar voor het hele team.

**De uitzondering op de muur (0045).** Je ziet een dossier van een ander team
zolang er **lopend** werk van jou op staat. Afgewerkt werk telt niet meer mee:
tot september hield één afgeronde taak een dossier voorgoed open — op de
testomgeving zag één medewerker 13 van zijn 31 dossiers alleen nog om die
reden, waaronder een vertrouwelijk dossier.

**Het team weghalen is een beheerdersbeslissing (0044–0045).** Verhuizen
tussen teams waar je zelf in zit, blijft gewoon werk en wordt gelogd. Het team
helemaal weghalen zet het dossier open voor het hele kantoor en mag daarom
alleen een kantoorbeheerder. Naar een team duwen waar je zelf niet in zit, kan
sowieso niet: de gewijzigde rij valt dan buiten je eigen bereik en RLS weigert
ze.

**Zes niveaus (0042).** Junior, senior, supervisor, manager, director,
partner. Vanaf manager mag je aangiftes goedkeuren, en `mag_goedkeuren` wordt
daaruit afgeleid in plaats van los aangevinkt. De rol (`medewerker` /
`kantoorbeheerder`) blijft een aparte as: die gaat over beheer in de app, niet
over beroepsniveau.

**Natuurlijke personen en de aangifte PB (0041).** Een klantdossier is sinds
0041 een rechtspersoon of een natuurlijke persoon. De aangifte
personenbelasting valt op 15 juli (eenvoudig) of 16 oktober (complex); sinds
2023 bestaat het aparte uitstel voor mandatarissen niet meer. Een eenmanszaak
heeft **geen** voorafbetalingen in dit systeem. §9 zegt "er is geen vijfde
voorafbetaling" — dat klopt voor vennootschappen, maar sinds inkomstenjaar
2026 bestaat er wel een vijfde voor eenmanszaken. Die is bewust niet gebouwd.

**Weekoverzicht (0043).** De maandagmail: te laat, deze week, de bak van je
team, en wat op je goedkeuring wacht. Kijkt door dezelfde muur als het scherm.
De inhoud staat in de databank en is getest; het verzenden hangt nog aan een
mailprovider.

**Goedkeuringsscherm.** Een eigen ingang voor wat op jouw goedkeuring wacht,
zonder deadlinevenster — anders verstopt het venster juist het oudste werk. In
twee lijsten: wat collega's indienden, en wat je zelf indiende (met de
four-eyes-waarschuwing erboven, want wie in bulk goedkeurt opent geen enkele
taak).

**UBO-bevestiging (0046).** Jaarlijks, voor vennootschappen, (i)vzw's en
stichtingen — niet voor een eenmanszaak. De wet geeft geen kalenderdatum,
alleen "elk jaar"; het anker is daarom het boekjaareinde + 6 maanden, dezelfde
grens als de algemene vergadering. De melding binnen de maand bij een
wijziging is bewust géén terugkerende taak: die hangt aan een gebeurtenis en
hoort ad hoc.

**De jaarlijkse vennootschapsbijdrage** is bewust géén verplichting in
Taskflow: die betaalt de vennootschap zelf, het kantoor doet er niets mee.

**Zelfregistratie is dicht — nagemeten op 04/09/2026.** §8 noemt dit een harde
voorwaarde: zolang "Allow new users to sign up" openstaat en de site publiek
bereikbaar is, kan een buitenstaander een eigen kantoor aanmaken en via de
gedeelde wettelijke kalender de deadlines van de echte klanten verschuiven.
Dat was tot nu een aanname. Een POST naar `/auth/v1/signup` met de publieke
sleutel antwoordt `422 signup_disabled`, dus de voorwaarde is vervuld. De
proef maakte geen account aan. Wie de instelling ooit weer aanzet, haalt
daarmee ook §8 onderuit.

## §12 — Correctie: de btw-kwartaaldeadline schuift niet meer op (04/09/2026)

Gevonden bij het eerste nazicht door de fiscalist-agent, en nagetrokken tegen
de btw-kalender 2026 van de FOD.

§9 legde vast dat de verlenging naar de eerstvolgende werkdag geldt voor maand-
én kwartaalaangiften. Dat was juist toen het opgeschreven werd en is het niet
meer. De FOD-kalender toont het verschil zwart-op-wit:

| | periode | FOD |
| --- | --- | --- |
| periodieke kwartaalaangifte | Q1-2026 | 27.04.2026 — nog verschoven |
| | Q2-2026 | 25.07.2026 — zaterdag, geen uitstel |
| | Q3-2026 | 25.10.2026 — zondag, geen uitstel |
| maandelijkse aangifte | mei 2026 | 22.06.2026 — nog steeds verschoven |
| bijzondere aangifte | Q1-2026 | 25.04.2026 — zaterdag, nooit verschoven |

De bijzondere aangifte schoof zelfs nooit mee; die stond dus vanaf het begin
fout.

**De keuze van het kantoor.** Valt de wettelijke datum op een zondag en schuift
ze niet op, dan plant Taskflow op de laatste werkdag ervóór. `due_date_wettelijk`
blijft de wettelijke datum, `due_date` wordt de vrijdag. Het dossier houdt de
wet bij, de takenlijst houdt het werk bij.

**Waarom een parameter en geen kolom.** De regel verschilt bínnen één
verplichtingstype: dezelfde `btw_aangifte` schuift vooruit voor een
maandaangever en achteruit voor een kwartaalaangever. De motortak weet welke
van de twee ze berekent en zegt het erbij (`p_verschuiving`, migratie 0048).

**De kanteldatum wordt gemodelleerd.** Kwartalen met een deadline vóór
01/05/2026 schuiven nog vooruit. Een oudere periode hergenereren hoort de
datum van toen te geven; het systeem mag niet liegen over het verleden.

Bij het live zetten zijn 49 kwartaaltaken en 11 bijzondere aangiftes
herberekend, alleen die van vandaag of later. Wat al gepasseerd is blijft
staan: de tolerantie bestond toen echt nog.

## §13 — De kwartaalaangifte bedrijfsvoorheffing (05/09/2026)

Tweede leemte uit het fiscale nazicht. Wie loon of bezoldigingen uitbetaalt,
houdt bedrijfsvoorheffing in en geeft die aan via Finprof. Onder het
grensbedrag van artikel 412, derde lid WIB 92 mag dat per kwartaal.

**De kwartaalkalender is een formule** en hoort dus in de motor: de 15de van
de maand na het kwartaal, zonder uitzondering over de jaren heen
(15.01.2026 · 15.04.2026 · 15.07.2026 · 15.10.2026 · 15.01.2027).

**De MAANDaangifte zit er bewust niet in.** Die is géén formule. Uit dezelfde
FOD-kalender voor 2026: januari → 13.02, februari → 13.03, maart → 15.04,
april → **13.05** (terwijl 15 mei een gewone vrijdag is), augustus → 14.08,
oktober → 13.11. April breekt elke regel die je zou kunnen bedenken. Een gok
in een deadlinesysteem is een gemiste aangifte, dus de maandkalender hoort in
`legal_calendar` — als aangekondigde data, niet als formule.

**Valt de 15de in het weekend, dan gaat de werkdatum naar de werkdag ervóór.**
De maandkalender toont welke kant de FOD op gaat (13.02, 13.03, 14.08, 13.11:
telkens vervroegd, nooit verlaat), en het is dezelfde richting die het kantoor
voor de btw koos. Binnen de horizon telt dat: 15.01.2028 en 15.04.2028 zijn
zaterdagen.

**Openstaande vraag voor het kantoor.** Erkende sociale secretariaten storten
tegen de *voorlaatste werkdag* van de maand na het kwartaal — een heel andere
termijn. Loopt de loonverwerking van een dossier via een sociaal secretariaat,
dan klopt deze taak daar niet.

De werkstroom "Fiches" heet vanaf nu **Personeel**: er zit meer in dan fiches.
Het pad blijft `fiches`, zodat bestaande links blijven werken.

## §14 — Een gewijzigd boekjaareinde (05/09/2026)

**Wat er misging.** Nagespeeld op een lokale kopie: zet je een dossier van
31/12 naar 30/06, dan blijven de al gegenereerde jaartaken op de oude datum
staan. Niet omdat iemand dat zo wou, maar omdat het periodelabel het jaartal
is: de motor rekent de juiste taak voor 2026 wél uit, botst op het bestaande
label, en `on conflict do nothing` gooit ze weg. Zonder melding.

| | periode | deadline |
| --- | --- | --- |
| jaarafsluiting 2026 | 01/01–31/12/2026 | 31/03/2027 — nog het oude boekjaar |
| jaarafsluiting 2027 | 01/01–31/12/2027 | 31/03/2028 — nog het oude boekjaar |
| jaarafsluiting 2028 | 01/07/2027–30/06/2028 | 02/10/2028 — nieuw |

Voor een compliancesysteem is dat de ergste soort fout: het scherm toont een
deadline, die deadline is verkeerd, en niets wijst erop.

**De keuze van het kantoor: automatisch herrekenen, mét een menselijke
goedkeuring ertussen.** Een boekjaar verzetten is zeldzaam en zelden
onschuldig — er hangt meestal een overgangsboekjaar aan vast, of het is een
typfout in het formulier. Stil herrekenen is in allebei de gevallen fout.

De wijziging wordt daarom gemeld (`boekjaar_wijzigingen`), de geraakte taken
worden op het klantdossier getoond, en pas een klik voert het door. Herrekenen
gebeurt door de oude taak te **annuleren** — dat maakt het periodelabel weer
vrij, want de unieke index en `upsert_generated_task` laten geannuleerde taken
allebei buiten beschouwing — en de generatie daarna zijn werk te laten doen.
De oude taak blijft in de geschiedenis staan, met de logregel erbij.

**Wat er niet herrekend wordt**, met de reden zichtbaar in het paneel: een
taak waaraan al gewerkt wordt, een taak met een handmatig afgesproken deadline
(die afspraak is met de klant gemaakt, niet door de motor), en een taak
waarvan de deadline al gepasseerd is.

**Welke verplichtingen het boekjaar volgen** staat als gegeven op
`obligation_types.volgt_boekjaar`, niet als lijst in code: de AV, de
jaarafsluiting, de UBO-bevestiging, de voorafbetalingen, de aangifte VenB en
RPB (zevende-maandregel op het boekjaareinde) en de neerlegging. De aangifte
personenbelasting staat er bewust níét bij: dat is een vaste kalenderdatum.

**Het echte overgangsboekjaar zit hier niet in.** Een boekjaar dat eenmalig 18
of 6 maanden duurt kan Taskflow niet uitdrukken: `clients` bewaart alleen een
maand en een dag, en de motor neemt op vijf plaatsen aan dat een boekjaar
precies één jaar duurt (`v_bstart := v_be - 1 jaar + 1 dag`). Wie een
overgangsjaar heeft, ziet zijn taken na deze migratie tenminste op het níéuwe
ritme staan; het overgangsjaar zelf blijft handwerk via een handmatig
afgesproken deadline per taak. Dat echt modelleren vraagt een tabel met een
begin- en einddatum per boekjaar per klant — een eigen beslissing van het
kantoor, en niet nodig zolang dit uitzonderlijk blijft.

## §15 — Een verplichting die op een afgesproken datum stopt (05/09/2026)

**De vraag van het kantoor**, over afwijkende boekjaren: *"Ik moet niet per se
weten hoelang die duurt, maar welke taken er blijven bestaan."* Het
schoolvoorbeeld is een vereffening.

**Wat er misging.** `client_obligations.geldig_tot` bestond al en het scherm
toonde hem, maar de motor keek er niet naar. De kolom deed één ding: een
verplichting valt weg zodra haar einddatum vóórbij is. Zolang die datum in de
toekomst lag, veranderde er niets. Nagespeeld, aangifte VenB met
`geldig_tot = 31/12/2026`:

| | boekjaar | aangifte |
| --- | --- | --- |
| 2025 | tot 31/12/2025 | 30/09/2026 |
| 2026 | tot 31/12/2026 | 30/09/2027 |
| 2027 | tot 31/12/2027 | 02/10/2028 — **hoort er niet** |

Het kantoor kon dus wél opschrijven dat een verplichting stopt, en Taskflow
bleef er taken voor maken.

**De grens ligt op de PERIODE, niet op de deadline.** Dat is het hele punt.
Sluit de vereffening op 31/12/2026, dan moet de aangifte over boekjaar 2026 er
nog steeds staan — die wordt pas op 30/09/2027 ingediend, negen maanden ná de
einddatum. Wat wegvalt is het boekjaar 2027, niet het papierwerk over 2026.

**Waar de controle zit.** In `upsert_generated_task`, niet in de achttien
takken van de motor: elke tak noemt zijn periode anders, maar ze komen
allemaal op dezelfde uitgang uit. De neerleggingstaak volgt vanzelf — die
wordt alleen gemaakt wanneer er een AV-taak voor diezelfde periode bestaat.

**Geen goedkeuring nodig, anders dan bij §14.** Een boekjaareinde verzetten is
vaak een typfout; een einddatum zetten is een uitdrukkelijke handeling met
precies dit als bedoeling.

### Wat een vereffening fiscaal betekent (opgezocht 05/09/2026)

Voor de discussie over een "in vereffening"-markering, met de bronnen erbij:

- **Alles blijft lopen tot de sluiting.** Een vennootschap wordt na ontbinding
  geacht voort te bestaan vóór haar vereffening (art. 2:76 WVV); de
  rechtspersoonlijkheid verdwijnt pas bij de sluiting. De vereffenaar dient de
  gewone jaarlijkse aangifte in voor elk boekjaar tot de sluiting (art. 305,
  derde lid in fine WIB 92) en legt jaarlijks een jaarrekening neer bij de NBB,
  ten laatste zeven maanden na het boekjaareinde (art. 2:99 WVV).
- **De ontbinding sluit het boekjaar** (art. 2:70, tweede lid WVV). Valt ze
  niet samen met de statutaire afsluitdatum, dan ontstaat er een verkort
  boekjaar met een eigen jaarrekening en een **"aangifte speciaal"**.
- **De aangifte speciaal is géén formule.** Art. 310, tweede lid WIB 92: de
  termijn mag niet korter zijn dan één maand vanaf de goedkeuring van de
  resultaten van de vereffening, noch langer dan zes maanden vanaf de laatste
  dag van het tijdperk. Het anker is dus een goedkeuringsdatum die Taskflow
  niet kent — dat wordt een datum die het kantoor invult, geen berekening.
- **Bij een ontbinding en vereffening in één akte (turboliquidatie)** is er
  maar één bijzonder belastbaar tijdperk en dus maar één aangifte.

## §16 — In vereffening, en vereffend (05/09/2026)

Het kantoor: *"In vereffening en vereffend is nog iets anders. Een dossier kan
in vereffening staan voor meerdere jaren, maar een vereffening is gedaan."*

Dat is ook wat de wet zegt, en het is de reden dat dit twee datums zijn en
geen statusvlag:

| | | wat er met de taken gebeurt |
| --- | --- | --- |
| `ontbonden_op` | de ontbinding | **niets** — alles loopt door |
| `vereffend_op` | de sluiting | alle lopende verplichtingen krijgen deze einddatum |

**Waarom de ontbinding niets verandert.** Een vennootschap wordt na ontbinding
geacht voort te bestaan vóór haar vereffening (art. 2:76 WVV); de
rechtspersoonlijkheid verdwijnt pas bij de sluiting. De vereffenaar dient
intussen elk jaar gewoon de aangifte in (art. 305, derde lid in fine WIB 92) en
legt elk jaar de jaarrekening neer bij de NBB, ten laatste zeven maanden na het
boekjaareinde (art. 2:99 WVV). Hoe lang dat duurt, doet er niet toe — er hangt
geen berekening aan de duur.

**Waarom "vereffend" niet hetzelfde is als "gearchiveerd".** Archiveren
annuleert alles wat nog openstaat (migratie 0026). Dat is hier fout: de
aangifte over het laatste boekjaar wordt maanden ná de sluiting ingediend en
moet blijven staan. Vereffend zetten legt daarom de einddatum van §15 op de
verplichtingen — de periode telt, niet de deadline. Archiveren kan daarna nog
altijd, wanneer het dossier echt afgewerkt is.

**Wat bewust NIET gegenereerd wordt: de aangifte speciaal.** De ontbinding
sluit het boekjaar (art. 2:70, tweede lid WVV); valt ze niet samen met de
statutaire afsluitdatum, dan ontstaat er een verkort boekjaar met een eigen
jaarrekening en een aangifte "speciaal". Dezelfde constructie herhaalt zich bij
de sluiting. Die aangiftes zitten er niet in omdat hun termijn géén formule is:
art. 310, tweede lid WIB 92 ankert hem op de goedkeuring van de resultaten van
de vereffening, en die datum kent Taskflow niet. Een gegokte datum is hier
erger dan geen datum. Het scherm zegt dat met zoveel woorden bij het vereffend
zetten, met de vraag er een losse taak voor te maken.

Bij een ontbinding en vereffening in één akte (turboliquidatie) is er maar één
bijzonder belastbaar tijdperk en dus maar één aangifte.

## §17 — `can_view_client()` gaat dicht voor de API (05/09/2026)

Al een tijd gemeld door de Supabase-advisor, en bij het nakijken bleek het meer
dan een vinkje op een lijstje.

**Wat er lekte.** De handtekening is `can_view_client(p_client_id,
p_employee_id)`. Die tweede parameter is het probleem: je vult er een
**willekeurige** medewerker in, niet jezelf. En omdat de functie
`security definer` is en `authenticated` er EXECUTE op had, hing ze aan
`/rest/v1/rpc/can_view_client`.

Live nagegaan op productie, als een gewone medewerker die het vertrouwelijke
dossier niet mag zien:

| vraag | antwoord |
| --- | --- |
| `select * from clients where id = <dossier>` | 0 rijen |
| `can_view_client(<dossier>, <zichzelf>)` | false |
| `can_view_client(<dossier>, <een collega>)` | **true** |
| `can_view_client(<onbestaand dossier>, <zichzelf>)` | null |

Hij ziet het dossier zelf niet, maar leert wél dat een welbepaalde collega er
toegang toe heeft — precies wat de vertrouwelijkheid moest afschermen. En
omdat een onbestaand dossier `null` geeft en een bestaand `false`, is het
meteen een bestaan-orakel. Met de medewerkerslijst ernaast, die het scherm
gewoon toont, is dat de volledige toegangskaart van elk vertrouwelijk dossier
— één vraag per combinatie.

**Waarom intrekken volstaat.** Nagekeken vóór het intrekken: geen enkele
RLS-policy roept haar aan, de app nergens, en de drie functies die haar wél
gebruiken (`can_access_client`, `enforce_task_instance_transition`,
`enforce_obligation_assignment_access`) zijn alle drie zelf `security definer`
en draaien dus als de eigenaar.

**Wat hier NIET mee opgelost is: `mag_klant_zien()`.** Zelfde vorm — een vrij
in te vullen `p_employee_id` — en óók uitvoerbaar door `authenticated`. Die kan
niet zomaar dicht: de policies `clients_select` en `clients_update` roepen haar
rechtstreeks aan, en een policy-expressie draait met de rechten van wie de
query stelt. De grant weghalen sluit de klantentabel voor iedereen. Het lek is
er ook smaller: je geeft de kenmerken van de klant zélf mee, dus je krijgt
vooral terug wat je al invulde; wat er wél uit te halen valt is of een
medewerker lopend werk heeft op een dossier-id dat je al kent. Echt dichtzetten
vraagt de `p_employee_id` vast te pinnen op de oproeper, en dat botst met de
interne oproepers die juist over een **andere** medewerker vragen (0015 kijkt
of de toegewezen medewerker het dossier mag zien). Aparte beslissing.
