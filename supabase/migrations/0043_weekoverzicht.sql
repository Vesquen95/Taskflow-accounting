-- ============================================================
-- 0043 — Het weekoverzicht: wat er in de maandagmail hoort
--
-- Taskflow laat vandaag nooit iets van zich horen. In de testronde met honderd
-- dossiers stonden 110 taken te laat, en het systeem zei dat alleen tegen wie
-- toevallig inlogde. Een deadlinesysteem dat zwijgt tot je het opent, is een
-- agenda die je moet onthouden open te slaan.
--
-- Deze migratie zet de INHOUD neer, niet het verzenden. Dat is met opzet: de
-- inhoud draagt alle oordelen (wat is dringend, wie hoort wat te zien) en is
-- hier testbaar; het verzenden is leidingwerk dat later aan een mailprovider
-- gehangen wordt.
--
-- ------------------------------------------------------------
-- Vier blokken, in deze volgorde
--
--   1. te laat            wat over datum is en op jouw naam staat
--   2. deze week          wat binnen zeven dagen vervalt, op jouw naam
--   3. bak van je team    werk dat nog niemand opgenomen heeft
--   4. wacht op jou       enkel voor wie mag goedkeuren
--
-- Achterstand staat vooraan omdat ze vooraan hoort. Wie een mail opent en als
-- eerste "deze week" leest, ziet de gemiste deadline pas na het scrollen.
--
-- ------------------------------------------------------------
-- Twee keuzes die het gedrag bepalen
--
--  * De functie kijkt door dezelfde muur als het scherm: mag_klant_zien()
--    (0039). Een weekoverzicht dat dossiers van een ander team zou noemen,
--    zou de afscherming langs de achterdeur omzeilen -- en per e-mail, waar ze
--    helemaal niet meer terug te halen is.
--
--  * Elke lijst is afgekapt, met het volledige aantal ernaast. Een mail met
--    tweehonderd regels wordt niet gelezen; een mail die zwijgt over wat ze
--    weglaat, is erger dan geen mail.
-- ============================================================

create or replace function public.weekoverzicht_voor(
  p_employee_id uuid,
  p_vandaag date default current_date,
  p_max_per_blok int default 15
)
returns jsonb
language sql
stable security definer set search_path = public
as $$
  with mij as (
    select e.id, e.naam, e.email, e.mag_goedkeuren, e.firm_id
    from public.employees e
    where e.id = p_employee_id and e.actief
  ),
  zichtbaar as (
    -- Alles wat deze medewerker mag zien, één keer bepaald. De muur van 0039
    -- geldt hier onverkort: een mail is geen achterdeur.
    select ti.id, ti.due_date, ti.status, ti.toegewezen_medewerker_id,
           ti.periode_label, ti.title,
           c.naam as klant, c.team_id,
           coalesce(ot.naam, ti.title, 'Ad-hoc taak') as verplichting
    from public.task_instances ti
    join public.clients c on c.id = ti.client_id
    join mij on mij.firm_id = c.firm_id
    left join public.obligation_types ot on ot.id = ti.obligation_type_id
    where ti.status not in ('ingediend_afgerond', 'geannuleerd')
      and c.actief
      and public.mag_klant_zien(c.id, c.vertrouwelijk, c.team_id, p_employee_id)
  ),
  mijn_teams as (
    select et.team_id from public.employee_teams et where et.employee_id = p_employee_id
  ),
  blokken as (
    select
      case
        when z.toegewezen_medewerker_id = p_employee_id and z.due_date < p_vandaag then 'te_laat'
        when z.toegewezen_medewerker_id = p_employee_id and z.due_date <= p_vandaag + 6 then 'deze_week'
        when z.toegewezen_medewerker_id is null
             and z.team_id in (select team_id from mijn_teams)
             and z.due_date <= p_vandaag + 13 then 'teambak'
        when z.status = 'wacht_op_goedkeuring'
             and (select mag_goedkeuren from mij)
             and z.toegewezen_medewerker_id is distinct from p_employee_id then 'wacht_op_jou'
        else null
      end as blok,
      z.*
    from zichtbaar z
  ),
  genummerd as (
    select b.*, row_number() over (partition by b.blok order by b.due_date, b.klant) as rij
    from blokken b
    where b.blok is not null
  ),
  per_blok as (
    select
      blok,
      count(*) as totaal,
      jsonb_agg(
        jsonb_build_object(
          'klant', klant,
          'verplichting', verplichting,
          'periode', periode_label,
          'deadline', due_date,
          'status', status
        )
        order by due_date, klant
      ) filter (where rij <= p_max_per_blok) as taken
    from genummerd
    group by blok
  )
  select jsonb_build_object(
    'medewerker', (select jsonb_build_object('id', id, 'naam', naam, 'email', email) from mij),
    'vandaag', p_vandaag,
    'blokken', coalesce(
      (select jsonb_object_agg(blok, jsonb_build_object('totaal', totaal, 'taken', coalesce(taken, '[]'::jsonb)))
       from per_blok),
      '{}'::jsonb
    ),
    -- Het scherm van de mail beslist zelf of er iets te melden valt; deze
    -- functie zegt alleen wat er is.
    'iets_te_melden', coalesce((select sum(totaal) from per_blok), 0) > 0
  )
  from mij;
$$;

comment on function public.weekoverzicht_voor(uuid, date, int) is
  'De inhoud van het weekoverzicht voor één medewerker: te laat, deze week, de bak van zijn team, en wat op zijn goedkeuring wacht. Kijkt door dezelfde muur als het scherm (mag_klant_zien, 0039). Geeft null terug voor een onbekende of inactieve medewerker.';

revoke execute on function public.weekoverzicht_voor(uuid, date, int) from public, anon, authenticated;

-- ------------------------------------------------------------
-- Wie er een krijgt
--
-- Alleen wie een gekoppeld account heeft: een uitgenodigde collega die nog
-- nooit ingelogd heeft, krijgt een mail over dossiers die hij nog niet kan
-- openen. En alleen wie iets te melden heeft -- een wekelijkse mail die "niets
-- te doen" zegt, leert mensen de mail weg te klikken.
-- ------------------------------------------------------------
create or replace function public.weekoverzicht_ontvangers(p_vandaag date default current_date)
returns table (employee_id uuid, email text, overzicht jsonb)
language sql
stable security definer set search_path = public
as $$
  select e.id, e.email, public.weekoverzicht_voor(e.id, p_vandaag)
  from public.employees e
  where e.actief
    and e.auth_user_id is not null
    and (public.weekoverzicht_voor(e.id, p_vandaag) ->> 'iets_te_melden')::boolean
  order by e.naam;
$$;

comment on function public.weekoverzicht_ontvangers(date) is
  'De medewerkers die deze week een weekoverzicht horen te krijgen, met hun overzicht erbij. Wie niets te melden heeft, krijgt geen mail: een wekelijkse "niets te doen" leert mensen de mail weg te klikken.';

revoke execute on function public.weekoverzicht_ontvangers(date) from public, anon, authenticated;
