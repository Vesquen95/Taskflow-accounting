# Taskflow deployen

## GitHub Pages (huidige opzet)

De workflow `.github/workflows/deploy.yml` bouwt en publiceert automatisch bij
elke push naar `claude/taskflow-webapp-subagents-mxc0yz` (de default branch).
Hij draait eerst lint, typecheck en de volledige testsuite — een kapotte build
gaat dus nooit live.

### Eenmalig instellen (twee stappen, in de repo-settings)

1. **Pages aanzetten** — Settings → Pages → *Source*: **GitHub Actions**.
   Zonder deze stap slaagt de build-job wel, maar faalt de deploy-job.

2. **De twee Supabase-waarden zetten** — Settings → Secrets and variables →
   Actions → tabblad *Variables* → *New repository variable*:
   - `VITE_SUPABASE_URL` → `https://zwxkftxfgwkdievgmiew.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` → de anon/publishable key uit het Supabase-
     dashboard (Project Settings → API).

   Deze staan bewust als *variables* en niet als *secrets*: de anon key is in
   Supabase's beveiligingsmodel publiek by design (hij zit sowieso in elke
   client-bundle), en de echte autorisatie zit in RLS. Zet hier **nooit** de
   service-role key — die omzeilt alle RLS.

Daarna staat de site op `https://vesquen95.github.io/Taskflow-accounting/`.

### Waarom `base` op de build-mode staat

GitHub Pages serveert een project-site vanaf `/<repo-naam>/`, niet vanaf de
domeinroot. Daarom draait de workflow `vite build --mode gh-pages`, wat in
`vite.config.ts` `base: '/Taskflow-accounting/'` activeert. Lokaal en bij
hosts die wél vanaf de root serveren blijft het `/`. De app gebruikt een
hash-router, dus er is geen SPA-rewrite/404-fallback nodig.

## Aandachtspunt: de site is publiek

Een Pages-site is voor iedereen bereikbaar. Sinds migratie 0014 is het
kantoor in de database op slot: `create_firm_and_admin()` weigert zodra er
één kantoor bestaat, dus een wildvreemde die zich registreert kan géén tweede
kantoor meer aanmaken en wordt dus ook nooit kantoorbeheerder.

Dat slot is er niet voor niets. Vóór 0014 kon een wildvreemde met één
registratie kantoorbeheerder van een eigen "kantoor" worden, en daarmee
schrijfrecht krijgen op de **gedeelde** wettelijke kalender
(`legal_calendar`, `public_holidays`). Eén request herschreef zo de
neerleggings- en aangiftedatum van élk dossier van het echte kantoor,
geboekt als vertrouwd systeemevent. Klantdata lekte daarbij niet — RLS hield
stand — maar de kalenderintegriteit wel. Het risico was dus niet "vreemden
maken een kantoor aan", maar "vreemden verzetten jouw wettelijke deadlines".
De kalenderherberekening is daarnaast per kantoor gescoped, zodat dit ook
standhoudt als er ooit bewust een tweede kantoor bijkomt.

Zet zelfregistratie daarnaast alsnog uit in het Supabase-dashboard —
Authentication → Sign In / Providers → **Allow new users to sign up** uit —
zodat er ook geen losse `auth.users`-rijen meer bijkomen. Bestaande
gebruikers kunnen gewoon inloggen. Collega's voeg je toe via het
medewerkersscherm (uitnodiging) plus een handmatig aangemaakte gebruiker in
het Supabase-dashboard.

Zet ook **Leaked password protection** aan (Authentication → Password): dat
toetst wachtwoorden bij registratie en wijziging af tegen HaveIBeenPwned.

Let ook op: sinds de security-fix vereist `create_firm_and_admin()` een
**bevestigd** e-mailadres. Zet Authentication → *Confirm email* aan, anders
blokkeert je eigen eerste registratie.

## Alternatief: Vercel / Netlify

Beide hosten dit zonder extra config vanaf de root (dus zonder `--mode
gh-pages`): repo koppelen, build command `npm run build`, output `dist`, en
dezelfde twee env-vars zetten. Voordeel t.o.v. Pages: preview-deploys per
branch en de mogelijkheid om de site achter een login/IP-restrictie te zetten.
