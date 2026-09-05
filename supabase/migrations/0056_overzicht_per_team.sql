-- ============================================================
-- 0056 — Een overzicht dat de supervisor en de manager wél kunnen openen
--
-- Aanleiding: het kantoor, over wie wat te zien krijgt. "Partners zijn
-- meestal lui en kijken hier niet veel en snel naar. Supervisor en manager
-- zullen het meeste moeten doen."
--
-- Nagemeten, en het systeem stond precies omgekeerd:
--
--   1. Het workload-dashboard was afgeschermd op `kantoorbeheerder`. De twee
--      graden die het meeste werk doen, hadden dus GEEN overzichtsscherm.
--   2. De zes graden bepaalden precies één ding -- of je mag goedkeuren.
--      Verder zag een junior exact dezelfde applicatie als een supervisor.
--   3. Elk scherm opent op "alles wat je mag zien". Gemeten op de
--      testomgeving: een junior met 279 eigen taken kreeg er 1.007 te zien,
--      een partner met 336 eigen taken kreeg er 3.588.
--
-- ------------------------------------------------------------
-- Waarom dit in de databank telt en niet in de browser
--
-- Het workload-dashboard haalde ELKE openstaande taak van het kantoor op --
-- 3.588 rijen met drie gejoinde objecten -- om er in de browser 66 getallen
-- van te maken. Traag, en er stond geen expliciete grens op de query, dus de
-- standaardgrens van PostgREST bepaalde stilzwijgend hoeveel er meekwam. Een
-- afgekapt totaal ziet er precies uit als een kloppend totaal.
--
-- Tellen hoort waar de rijen staan.
--
-- ------------------------------------------------------------
-- Waarom per team, en waarom dat vanzelf de juiste afbakening geeft
--
-- De teller loopt per team, en de muur van 0039/0045 doet de rest: een
-- supervisor ziet de rijen van zijn eigen team, een kantoorbeheerder ziet ze
-- allemaal. Geen aparte "voor jou"- en "kantoorbrede" variant die uit elkaar
-- kan lopen -- één query, en wie je bent bepaalt wat eruit komt.
--
-- ------------------------------------------------------------
-- De vier getallen, en waarom net deze
--
--   te laat            waarvan wettelijk apart, want een gemiste wettelijke
--                      termijn kost het kantoor iets anders dan een gemiste
--                      interne rapportering.
--   niemand op         werk zonder naam. Apart geteld hoeveel daarvan al te
--                      laat is: dat is het gevaarlijkste getal van allemaal,
--                      want er is niemand die eraan herinnerd wordt.
--   te lang bij klant  `wacht_op_klant` is waar werk blijft liggen. Op de
--                      testomgeving wachtte 23 van de 27 al langer dan de
--                      21 dagen uit 0047.
--   wacht op keuring   wat op een handtekening ligt.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Wie mag het overzicht zien
--
-- Aparte functie naast niveau_mag_goedkeuren(), en niet dezelfde: goedkeuren
-- begint bij manager, meekijken begint bij supervisor. Die twee grenzen
-- horen los te kunnen bewegen.
-- ------------------------------------------------------------
create or replace function public.niveau_mag_overzicht(p_niveau public.medewerker_niveau)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_niveau in ('supervisor', 'manager', 'director', 'partner');
$$;

comment on function public.niveau_mag_overzicht(public.medewerker_niveau) is
  'Vanaf welke graad je het kantooroverzicht mag openen: supervisor en hoger. Lager dan de '
  'grens voor goedkeuren (manager), want meekijken en tekenen zijn niet hetzelfde (0056).';

revoke execute on function public.niveau_mag_overzicht(public.medewerker_niveau) from public, anon;
grant execute on function public.niveau_mag_overzicht(public.medewerker_niveau) to authenticated;

-- ------------------------------------------------------------
-- 2. Het overzicht zelf
-- ------------------------------------------------------------
create or replace function public.kantooroverzicht()
returns table (
  team_id uuid,
  team_code text,
  team_naam text,
  open_totaal int,
  te_laat int,
  te_laat_wettelijk int,
  niemand_op int,
  niemand_op_te_laat int,
  te_lang_bij_klant int,
  wacht_op_goedkeuring int
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_emp uuid := public.current_employee_id();
  v_niveau public.medewerker_niveau;
  v_beheerder boolean;
begin
  if v_emp is null then
    raise exception 'Deze weergave vereist een ingelogde, gekoppelde medewerker'
      using errcode = 'insufficient_privilege';
  end if;

  select e.niveau, e.rol = 'kantoorbeheerder' into v_niveau, v_beheerder
  from public.employees e where e.id = v_emp;

  -- Een kantoorbeheerder mag er sowieso bij: die beheert het kantoor, ook
  -- zonder graad. Voor de rest beslist de graad.
  if not coalesce(v_beheerder, false) and not coalesce(public.niveau_mag_overzicht(v_niveau), false) then
    raise exception
      'Het kantooroverzicht is bedoeld voor supervisors en hoger. Je eigen werk staat op de kalender en in de werkstromen.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    t.id,
    t.code,
    t.naam,
    count(*)::int,
    count(*) filter (where ti.due_date < current_date)::int,
    count(*) filter (where ti.due_date < current_date and ot.categorie = 'wettelijk')::int,
    count(*) filter (where ti.toegewezen_medewerker_id is null)::int,
    count(*) filter (where ti.toegewezen_medewerker_id is null and ti.due_date < current_date)::int,
    -- 21 dagen: dezelfde grens als WACHT_LANG_VANAF_DAGEN in het scherm
    -- (0047). Staat hier hardgecodeerd naast die van de frontend; er is maar
    -- één getal en het verandert zelden, maar wie het verzet, verzet het op
    -- twee plaatsen.
    count(*) filter (
      where ti.status = 'wacht_op_klant'
        and ti.wacht_op_klant_sinds < now() - interval '21 days'
    )::int,
    count(*) filter (where ti.status = 'wacht_op_goedkeuring')::int
  from public.task_instances ti
  join public.clients c on c.id = ti.client_id
  left join public.teams t on t.id = c.team_id
  left join public.obligation_types ot on ot.id = ti.obligation_type_id
  where ti.status not in ('ingediend_afgerond', 'geannuleerd')
    and c.actief
    -- Twee grenzen, en allebei nodig. Het RLS-beleid op `clients` doet
    -- precies hetzelfde: `firm_id = current_employee_firm_id() and
    -- mag_klant_zien(...)`. Een kantoorbeheerder passeert de MUUR maar niet
    -- de KANTOORGRENS -- mag_klant_zien() kijkt helemaal niet naar firm_id.
    -- Deze functie is security definer en heeft dus geen RLS onder zich; zij
    -- moet die grens zelf zetten. De testreeks ving dit: zonder de eerste
    -- regel telde het overzicht de teams van elk kantoor in de databank mee.
    and c.firm_id = public.current_employee_firm_id()
    and public.mag_klant_zien(c.id, c.vertrouwelijk, c.team_id, v_emp)
  group by t.id, t.code, t.naam
  order by
    count(*) filter (where ti.toegewezen_medewerker_id is null and ti.due_date < current_date) desc,
    count(*) filter (where ti.due_date < current_date) desc,
    t.code nulls last;
end;
$$;

comment on function public.kantooroverzicht() is
  'De vier risicogetallen per team, geteld in de databank en afgebakend door dezelfde muur als '
  'de schermen. Vanaf supervisor (0056).';

revoke execute on function public.kantooroverzicht() from public, anon;
grant execute on function public.kantooroverzicht() to authenticated;

-- ------------------------------------------------------------
-- 3. Hetzelfde voor het workload-dashboard
--
-- Dat scherm beantwoordt een andere vraag -- wie zit vol -- en blijft dus
-- bestaan, maar het haalde de rijen op dezelfde verkeerde manier op. Nu telt
-- ook dat in de databank, met dezelfde muur eronder.
-- ------------------------------------------------------------
create or replace function public.workload_per_medewerker()
returns table (
  employee_id uuid,
  naam text,
  niveau public.medewerker_niveau,
  open_totaal int,
  te_laat int,
  binnen_7_dagen int,
  binnen_31_dagen int,
  wacht_op_goedkeuring int
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_emp uuid := public.current_employee_id();
  v_niveau public.medewerker_niveau;
  v_beheerder boolean;
begin
  if v_emp is null then
    raise exception 'Deze weergave vereist een ingelogde, gekoppelde medewerker'
      using errcode = 'insufficient_privilege';
  end if;

  select e.niveau, e.rol = 'kantoorbeheerder' into v_niveau, v_beheerder
  from public.employees e where e.id = v_emp;

  if not coalesce(v_beheerder, false) and not coalesce(public.niveau_mag_overzicht(v_niveau), false) then
    raise exception
      'Het workload-overzicht is bedoeld voor supervisors en hoger.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    e.id,
    e.naam,
    e.niveau,
    count(ti.id)::int,
    count(ti.id) filter (where ti.due_date < current_date)::int,
    count(ti.id) filter (where ti.due_date between current_date and current_date + 7)::int,
    count(ti.id) filter (where ti.due_date between current_date and current_date + 31)::int,
    count(ti.id) filter (where ti.status = 'wacht_op_goedkeuring')::int
  from public.employees e
  left join public.task_instances ti
    on ti.toegewezen_medewerker_id = e.id
   and ti.status not in ('ingediend_afgerond', 'geannuleerd')
   and exists (
     select 1 from public.clients c
     where c.id = ti.client_id
       and c.actief
       and c.firm_id = public.current_employee_firm_id()
       and public.mag_klant_zien(c.id, c.vertrouwelijk, c.team_id, v_emp)
   )
  where e.actief and e.firm_id = public.current_employee_firm_id()
  group by e.id, e.naam, e.niveau
  order by
    count(ti.id) filter (where ti.due_date < current_date) desc,
    count(ti.id) desc,
    e.naam;
end;
$$;

comment on function public.workload_per_medewerker() is
  'Open werk, achterstand en wat er op goedkeuring ligt, per medewerker. Geteld in de databank '
  'in plaats van door elke rij naar de browser te sturen; dezelfde muur eronder (0056).';

revoke execute on function public.workload_per_medewerker() from public, anon;
grant execute on function public.workload_per_medewerker() to authenticated;
