-- ============================================================
-- 0057 — De horizon van 36 naar 15 maanden
--
-- Het kantoor: "Een dossier bekijken we niet 3 jaren vanaf vandaag, meestal is
-- een jaar ruim voldoende voor ons." De takenlijst was te lang geworden om nog
-- overzicht te geven.
--
-- Gemeten op 06/09/2026, met een volledig gevulde horizon van 36 maanden:
--
--   te laat                649
--   binnen 12 maanden    1.475
--   12-15 maanden          324
--   15-18 maanden          310
--   meer dan 18 maanden  2.292      <- 45% van de lijst
--
-- ------------------------------------------------------------
-- Waarom 15 en niet 12
--
-- Twaalf zou de lopende cyclus afkappen. Gemeten: van alle taken over een
-- periode die uiterlijk eind 2026 sluit, reiken deze het verst vooruit --
--
--   aangifte personenbelasting   18/10/2027   13,4 maanden
--   aangifte VenB / RPB          30/09/2027   12,8 maanden
--   neerlegging jaarrekening     30/07/2027   10,8 maanden
--
-- Bij een horizon van twaalf maanden vallen de twee bovenste dus weg: de
-- aangiftes van het LOPENDE boekjaar, precies de taken waarop het kantoor
-- plant. Vijftien laat ze staan met marge.
--
-- Vijftien maanden houdt elke taak van de lopende cyclus zichtbaar en haalt
-- ruwweg de helft van de lijst weg.
--
-- ------------------------------------------------------------
-- Wat hier NIET gebeurt: taken laten ontstaan bij het afsluiten van de vorige
--
-- Het kantoor stelde voor om de volgende periode pas aan te maken zodra de
-- vorige afgesloten wordt (kwartaal 1 2026 dicht -> kwartaal 1 2027 erbij).
-- Aantrekkelijk, maar het ruilt de belangrijkste eigenschap van deze motor weg.
--
-- Vandaag geldt: wat er hoort te bestaan is een zuivere functie van de
-- dossiers, hun verplichtingen, de regels en de horizon. Draai de generatie
-- opnieuw en alles klopt weer. Dáárop steunen alle correcties die we al
-- gedaan hebben -- 0017, 0033, 0048 en 0049 zetten een verkeerde regel recht
-- door opnieuw te genereren -- en 0052 is er volledig op gebouwd: annuleren en
-- laten hergenereren.
--
-- Met een ketting hangt de toekomst aan de geschiedenis. Een taak die nooit
-- afgesloten wordt, breekt hem. Er stonden op dat moment 649 taken te laat:
-- dat zouden 649 stilgevallen kettingen zijn, waarbij de slechtst opgevolgde
-- dossiers de mínste toekomstige taken krijgen. Precies omgekeerd aan wat een
-- deadlinesysteem hoort te doen, en niets dat het opmerkt.
--
-- Het motief hield ook geen stand: een volledige herberekening over 103
-- dossiers duurt 793 ms.
--
-- ------------------------------------------------------------
-- Het doorschuiven was al geautomatiseerd
--
-- Migratie 0025 zette daar `onderhoud_taken()` voor neer, en er staat een
-- cron-job op (`taskflow-horizon-onderhoud`, elke 1e van de maand om 03:00).
-- Die liep laatst op 01/09/2026. Er is dus geen risico dat een kortere horizon
-- stilvalt omdat niemand op een knop duwt.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De horizon op één plek
--
-- Stond op drie plaatsen los van elkaar: 36 in onderhoud_taken(), 36 in
-- sync_client_tasks() en 3 als standaard in het scherm. Die laatste twee
-- verschilden dus een factor twaalf -- één klant opslaan genereerde 36
-- maanden vooruit, de knop "genereer taken" deed er 3.
-- ------------------------------------------------------------
create or replace function public.horizon_maanden()
returns int
language sql
immutable
set search_path = public
as $$
  select 15;
$$;

comment on function public.horizon_maanden() is
  'Hoe ver vooruit de taakgeneratie kijkt: 15 maanden (0057). Niet 12: de aangifte '
  'personenbelasting (13,4 maanden) en de aangifte VenB (12,8 maanden) van het LOPENDE boekjaar '
  'zouden dan uit beeld vallen. Eén plek, zodat het onderhoud, het opslaan van een klant en het '
  'scherm niet uit elkaar lopen.';

revoke execute on function public.horizon_maanden() from public, anon;
grant execute on function public.horizon_maanden() to authenticated;

-- ------------------------------------------------------------
-- 2. Wat er al buiten de horizon staat, wordt opgeruimd
--
-- Zonder dit verandert er niets aan de bestaande lijst: de generatie maakt
-- alleen bij, ze ruimt niet op. Annuleren en niet verwijderen -- zelfde keuze
-- als overal (0021, 0053): de rij blijft in de geschiedenis van het dossier
-- staan.
--
-- Alleen taken die nog OPEN staan. Waar al aan gewerkt wordt (in uitvoering,
-- wacht op klant, wacht op goedkeuring) blijft staan: daar hangt werk aan
-- vast, en dat weggooien omdat de horizon korter werd is niet aan het systeem.
-- Ad-hoc taken blijven sowieso buiten schot; die heeft iemand met de hand
-- gemaakt en zijn geen gevolg van de horizon.
-- ------------------------------------------------------------
create or replace function public.snoei_taken_buiten_horizon()
returns int
language plpgsql
security definer set search_path = public
as $$
declare
  r_firm record;
  r record;
  v_grens date := (current_date + (public.horizon_maanden() || ' months')::interval)::date;
  v_auth uuid;
  v_actor uuid;
  v_aantal int := 0;
begin
  -- Per kantoor, want de actor hoort bij het kantoor.
  --
  -- Waarom er überhaupt een actor nodig is: elke statuswijziging vereist een
  -- echte, ingelogde medewerker (0011) -- "nooit systeem" is een uitgangspunt
  -- van dit ontwerp, geen detail. Deze functie draait echter vanuit de
  -- maandelijkse cron, zonder sessie. Ze neemt daarom voor de duur van het
  -- snoeien de identiteit aan van de kantoorbeheerder van dat kantoor, zodat
  -- het audittrail een naam draagt in plaats van een leegte.
  --
  -- Twee instellingen, want auth.uid() leest in productie de JWT en in de
  -- lokale testopstelling een sessievariabele. Eén ervan zetten zou de functie
  -- in de andere omgeving stil laten falen.
  for r_firm in select id from public.firms loop
    select e.id, e.auth_user_id into v_actor, v_auth
    from public.employees e
    where e.firm_id = r_firm.id and e.rol = 'kantoorbeheerder' and e.actief
      and e.auth_user_id is not null
    order by e.created_at asc
    limit 1;
    -- Geen beheerder met een login: dan is er niemand om dit op naam te
    -- zetten, en dan snoeien we hier niet. Liever een te lange lijst dan een
    -- geschiedenis zonder auteur.
    continue when v_actor is null;

    perform set_config('taskflow.test_uid', v_auth::text, true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_auth, 'role', 'authenticated')::text, true);

    for r in
      select ti.id
      from public.task_instances ti
      join public.clients c on c.id = ti.client_id
      where c.firm_id = r_firm.id
        and ti.bron_type = 'automatisch_gegenereerd'
        and ti.status = 'open'
        and ti.due_date > v_grens
        -- Een vervolgtaak hangt aan haar voorloper en niet aan de horizon.
        -- De neerlegging van de jaarrekening wordt aangemaakt zodra de
        -- algemene vergadering bestaat, met een datum dertig dagen later --
        -- die kan dus net voorbij de horizon vallen terwijl de AV er nog
        -- binnen zit. Snoeide je haar toch weg, dan maakt de volgende ronde
        -- haar meteen opnieuw aan (de unieke index laat geannuleerde rijen
        -- buiten beschouwing) en jaagt het onderhoud zichzelf achterna.
        -- Sectie 33 van de testreeks ving precies dat.
        and ti.voorloper_taak_id is null
    loop
      update public.task_instances set status = 'geannuleerd' where id = r.id;

      insert into public.task_status_log (
        task_instance_id, event_type, actor_employee_id, trigger_bron, notitie
      ) values (
        r.id, 'taak_inhoud_gewijzigd', v_actor, 'kalender_herberekening',
        'Buiten de generatiehorizon van ' || public.horizon_maanden() ||
        ' maanden gevallen. De taakgeneratie maakt deze periode opnieuw aan zodra de horizon opschuift.'
      );
      v_aantal := v_aantal + 1;
    end loop;
  end loop;

  perform set_config('taskflow.test_uid', '', true);
  perform set_config('request.jwt.claims', '', true);
  return v_aantal;
end;
$$;

comment on function public.snoei_taken_buiten_horizon() is
  'Annuleert de nog open, automatisch gegenereerde taken die verder liggen dan de horizon. Ze '
  'komen vanzelf terug zodra de horizon opschuift -- de unieke index laat geannuleerde rijen '
  'buiten beschouwing (0057).';

revoke all on function public.snoei_taken_buiten_horizon() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Het maandelijkse onderhoud gebruikt de nieuwe horizon en snoeit
-- ------------------------------------------------------------
alter table public.onderhoud_log
  add column if not exists gesnoeide_taken int;

comment on column public.onderhoud_log.gesnoeide_taken is
  'Hoeveel taken deze ronde buiten de horizon vielen en geannuleerd werden (0057).';

do $patch$
declare
  v_def text;
  v_anker text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'onderhoud_taken';

  if v_def is null then
    raise exception '0057: onderhoud_taken() bestaat niet.';
  end if;
  if position('snoei_taken_buiten_horizon' in v_def) > 0 then
    raise notice '0057: het onderhoud snoeit al.';
    return;
  end if;

  -- (a) de horizon van de generatielus
  v_anker := 'v_taken := v_taken + public.generate_task_instances_intern(r_firm.id, 36, 0);';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0057: het anker van de generatielus past niet exact één keer.';
  end if;
  v_def := replace(v_def, v_anker,
    'v_taken := v_taken + public.generate_task_instances_intern(r_firm.id, public.horizon_maanden(), 0);');

  -- (b) snoeien ná het genereren, en het aantal mee in het logboek
  v_anker := '    update public.onderhoud_log' || E'\n' ||
             '       set geeindigd_op = now(), nieuwe_taken = v_taken, nieuwe_feestdagen = v_feestdagen' || E'\n' ||
             '     where id = v_log_id;';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0057: het anker van de afsluitende logregel past niet exact één keer.';
  end if;
  v_def := replace(v_def, v_anker,
    '    -- 3. Snoeien wat buiten de horizon valt. Ná het genereren: anders' || E'\n' ||
    '    --    snoeit deze ronde weg wat de volgende meteen weer aanmaakt.' || E'\n' ||
    '    v_gesnoeid := public.snoei_taken_buiten_horizon();' || E'\n' ||
    '' || E'\n' ||
    '    update public.onderhoud_log' || E'\n' ||
    '       set geeindigd_op = now(), nieuwe_taken = v_taken, nieuwe_feestdagen = v_feestdagen,' || E'\n' ||
    '           gesnoeide_taken = v_gesnoeid' || E'\n' ||
    '     where id = v_log_id;');

  -- (c) de variabele erbij
  v_anker := '  v_taken int := 0;';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0057: het anker van het declaratieblok past niet exact één keer.';
  end if;
  v_def := replace(v_def, v_anker, v_anker || E'\n' || '  v_gesnoeid int := 0;');

  execute v_def;
end
$patch$;

-- Ook de feestdagenkalender hoeft niet meer tot 2032 te lopen; drie jaar over
-- een horizon van vijftien maanden is nog altijd ruim.
do $patch$
declare
  v_def text;
  v_anker text;
begin
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'onderhoud_taken';
  v_anker := 'v_horizon_jaar int := extract(year from (current_date + interval ''36 months''))::int;';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise notice '0057: het anker van het feestdagenjaar past niet; ongewijzigd gelaten.';
    return;
  end if;
  v_def := replace(v_def, v_anker,
    'v_horizon_jaar int := extract(year from (current_date + (public.horizon_maanden() || '' months'')::interval))::int;');
  execute v_def;
end
$patch$;

-- ------------------------------------------------------------
-- 4. En het opslaan van één klant gebruikt dezelfde horizon
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'sync_client_tasks';

  if v_def is null then
    raise exception '0057: sync_client_tasks() bestaat niet.';
  end if;

  v_anker := 'v_nieuw := public.generate_task_instances_intern(v_firm_id, 36, 0, p_client_id);';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0057: het anker van de generatie in sync_client_tasks past niet exact één keer.';
  end if;

  v_def := replace(v_def, v_anker,
    'v_nieuw := public.generate_task_instances_intern(v_firm_id, public.horizon_maanden(), 0, p_client_id);');

  execute v_def;
end
$patch$;
