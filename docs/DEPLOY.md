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

Een Pages-site is voor iedereen bereikbaar, en de registratieflow is
self-serve — wie zich registreert maakt een eigen kantoor aan op hetzelfde
Supabase-project. Klantdata blijft afgeschermd door RLS (niemand ziet
andermans kantoor), maar vreemden kunnen wél kantoren aanmaken op jouw
instance, en de demo-seed draait bij elke nieuwe registratie.

Zodra je zelf geregistreerd bent, zet je dit dicht in het Supabase-dashboard:
Authentication → Sign In / Providers → **Allow new users to sign up** uit.
Bestaande gebruikers kunnen dan gewoon inloggen; nieuwe registraties niet meer.
Collega's voeg je nadien toe via het medewerkersscherm (uitnodiging) plus een
handmatig aangemaakte gebruiker in het Supabase-dashboard.

Let ook op: sinds de security-fix vereist `create_firm_and_admin()` een
**bevestigd** e-mailadres. Zet Authentication → *Confirm email* aan, anders
blokkeert je eigen eerste registratie.

## Alternatief: Vercel / Netlify

Beide hosten dit zonder extra config vanaf de root (dus zonder `--mode
gh-pages`): repo koppelen, build command `npm run build`, output `dist`, en
dezelfde twee env-vars zetten. Voordeel t.o.v. Pages: preview-deploys per
branch en de mogelijkheid om de site achter een login/IP-restrictie te zetten.
