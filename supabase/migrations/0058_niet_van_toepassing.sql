-- ============================================================
-- 0058 — "Niet van toepassing voor deze periode"
--
-- Het kantoor: "Maak iets zoals annuleren om verder te kunnen, of een knop
-- niet van toepassing voor deze maand of kwartaal."
--
-- Het gat dat dit vult zit tussen twee bestaande uitkomsten:
--
--   ingediend/afgerond   het werk is gedaan en ingediend. Vereist bij een
--                        wettelijke taak de vier-ogenstap (0011), en terecht.
--   geannuleerd          de taak had niet mogen bestaan: de verplichting is
--                        gestopt, de klant is gearchiveerd, het boekjaar is
--                        verzet, of ze viel buiten de horizon.
--
-- Wat er ontbrak is het gewone geval: de verplichting loopt, de taak was
-- terecht aangemaakt, maar er valt déze periode niets aan te geven. Geen
-- omzet dit kwartaal, geen lonen dit jaar, geen verrichtingen. Dat is geen
-- afgeronde aangifte -- die is er niet -- en het is ook geen fout in de
-- planning.
--
-- Vandaag moest zo'n taak open blijven staan of oneerlijk afgevinkt worden.
-- Het eerste vervuilt de achterstand, het tweede schrijft een historiek die
-- zegt dat er iets ingediend en goedgekeurd is.
--
-- ------------------------------------------------------------
-- Waarom geen nieuwe status
--
-- De statusreeks raakt zowat alles: de filters, de badges, NOT_FINAL in de
-- schermen, het weekoverzicht, de tellingen van het kantooroverzicht, de RLS.
-- Een zevende waarde toevoegen betekent al die plekken nalopen, met de kans
-- dat er één vergeten wordt en de taak daar stil in de verkeerde bak valt.
--
-- Daarom: de status blijft `geannuleerd` -- de taak is en blijft afgesloten
-- en telt nergens meer mee -- en er komt een REDEN naast. Het scherm toont
-- "Niet van toepassing" waar die reden staat, en "Geannuleerd" waar niet.
--
-- ------------------------------------------------------------
-- Het echte probleem: ze moet wegblijven
--
-- Een geannuleerde taak bezet haar periodeslot niet: de unieke index en
-- `upsert_generated_task` laten geannuleerde rijen allebei buiten
-- beschouwing. Dat is met opzet -- 0052 en 0053 steunen erop om taken te
-- kunnen hérmaken. Maar het betekent ook dat de volgende generatieronde deze
-- taak gewoon opnieuw aanmaakt, en dan is de knop een knop die niets doet.
--
-- Vandaar de controle in `upsert_generated_task`, op dezelfde plek als de
-- einddatum van 0053: staat er voor deze klant, verplichting en periode een
-- rij die op "niet van toepassing" gezet is, dan wordt er niets nieuws
-- gemaakt. Eén plek, alle achttien takken.
--
-- ------------------------------------------------------------
-- Een reden is verplicht
--
-- Zonder reden is dit precies het soort stille gat waar dit systeem tegen
-- gebouwd is: een wettelijke taak die verdwijnt zonder dat iemand over een
-- jaar nog weet waarom. De reden staat in de historiek van het dossier, met
-- de naam van wie ze gaf.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De markering
-- ------------------------------------------------------------
alter table public.task_instances
  add column if not exists niet_van_toepassing boolean not null default false,
  add column if not exists niet_van_toepassing_reden text;

comment on column public.task_instances.niet_van_toepassing is
  'Deze periode was er niets aan te geven. De taak staat op geannuleerd, maar anders dan bij een '
  'gewone annulering maakt de generatie ze NIET opnieuw aan (0058).';
comment on column public.task_instances.niet_van_toepassing_reden is
  'Waarom er deze periode niets aan te geven was. Verplicht: een wettelijke taak die verdwijnt '
  'zonder reden is een gat waar over een jaar niemand meer uit raakt (0058).';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'task_instances_nvt_heeft_reden') then
    alter table public.task_instances
      add constraint task_instances_nvt_heeft_reden check (
        not niet_van_toepassing
        or (niet_van_toepassing_reden is not null
            and char_length(trim(niet_van_toepassing_reden)) >= 3)
      );
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. De markering is alleen via de functie hieronder te zetten
--
-- Zonder dit kan wie het dossier mag bewerken de vlag rechtstreeks via de API
-- zetten, en dan verdwijnt een wettelijke taak voorgoed uit de generatie
-- zonder logregel en zonder reden. Zelfde patroon als de andere kolommen die
-- de trigger bevriest.
-- ------------------------------------------------------------
create or replace function public.taskflow_zet_nvt(p_task_id uuid)
returns boolean
language sql stable
set search_path = public
as $$
  select coalesce(
    nullif(current_setting('taskflow.nvt_task_id', true), '') = p_task_id::text,
    false
  );
$$;

revoke all on function public.taskflow_zet_nvt(uuid) from public, anon, authenticated;

do $patch$
declare
  v_def text;
  v_anker text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'enforce_task_instance_transition';

  if v_def is null then
    raise exception '0058: enforce_task_instance_transition() bestaat niet.';
  end if;
  if position('niet_van_toepassing' in v_def) > 0 then
    raise notice '0058: de trigger bewaakt de markering al.';
    return;
  end if;

  v_anker := '  new.due_date_handmatig_op := old.due_date_handmatig_op;';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0058: het anker van de bevroren kolommen past niet exact één keer.';
  end if;

  v_def := replace(v_def, v_anker,
    v_anker || E'\n' ||
    '  -- 0058: eigendom van taak_niet_van_toepassing(). Rechtstreeks te zetten' || E'\n' ||
    '  -- zou een wettelijke taak voorgoed uit de generatie halen zonder reden' || E'\n' ||
    '  -- en zonder spoor.' || E'\n' ||
    '  if not public.taskflow_zet_nvt(old.id) then' || E'\n' ||
    '    new.niet_van_toepassing := old.niet_van_toepassing;' || E'\n' ||
    '    new.niet_van_toepassing_reden := old.niet_van_toepassing_reden;' || E'\n' ||
    '  end if;');

  execute v_def;
end
$patch$;

-- ------------------------------------------------------------
-- 3. De handeling zelf
-- ------------------------------------------------------------
create or replace function public.taak_niet_van_toepassing(p_task_id uuid, p_reden text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
  v_taak record;
begin
  if v_actor is null then
    raise exception 'Deze bewerking vereist een ingelogde, gekoppelde medewerker'
      using errcode = 'insufficient_privilege';
  end if;
  if p_reden is null or char_length(trim(p_reden)) < 3 then
    raise exception
      'Geef kort aan waarom er deze periode niets aan te geven was. Zonder reden verdwijnt de taak zonder dat iemand later nog weet waarom.'
      using errcode = 'check_violation';
  end if;

  select ti.*, c.id as klant into v_taak
  from public.task_instances ti
  join public.clients c on c.id = ti.client_id
  where ti.id = p_task_id;
  if not found then
    raise exception 'Taak niet gevonden';
  end if;
  if not public.can_access_client(v_taak.client_id) then
    raise exception 'Geen toegang tot dit dossier'
      using errcode = 'insufficient_privilege';
  end if;

  if v_taak.status in ('ingediend_afgerond', 'geannuleerd') then
    raise exception 'Deze taak is al afgesloten (%)', v_taak.status
      using errcode = 'check_violation';
  end if;
  -- Alleen voor een terugkerende verplichting. Een ad-hoc taak hoort bij geen
  -- enkele periode; die annuleer je gewoon.
  if v_taak.obligation_type_id is null or v_taak.periode_label is null then
    raise exception
      'Dit is een losse taak zonder periode. "Niet van toepassing" gaat over een maand of kwartaal van een terugkerende verplichting; een losse taak annuleer je.'
      using errcode = 'check_violation';
  end if;

  perform set_config('taskflow.nvt_task_id', p_task_id::text, true);
  update public.task_instances
  set status = 'geannuleerd',
      niet_van_toepassing = true,
      niet_van_toepassing_reden = trim(p_reden)
  where id = p_task_id;
  perform set_config('taskflow.nvt_task_id', '', true);

  insert into public.task_status_log (
    task_instance_id, event_type, actor_employee_id, trigger_bron, notitie
  ) values (
    p_task_id, 'taak_inhoud_gewijzigd', v_actor, 'medewerker_actie',
    'Niet van toepassing voor deze periode: ' || trim(p_reden) ||
    ' — de taakgeneratie maakt deze periode niet opnieuw aan.'
  );
end;
$$;

comment on function public.taak_niet_van_toepassing(uuid, text) is
  'Sluit één periode af omdat er niets aan te geven was. Anders dan afronden beweert het niet dat '
  'er iets ingediend is, en anders dan een gewone annulering komt de taak niet terug bij de '
  'volgende generatieronde (0058).';

revoke execute on function public.taak_niet_van_toepassing(uuid, text) from public, anon;
grant execute on function public.taak_niet_van_toepassing(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 4. En de motor maakt haar niet opnieuw aan
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'upsert_generated_task';

  if v_def is null then
    raise exception '0058: upsert_generated_task() bestaat niet.';
  end if;
  if position('niet_van_toepassing' in v_def) > 0 then
    raise notice '0058: de motor houdt er al rekening mee.';
    return;
  end if;

  v_anker := '  perform set_config(''taskflow.generating'', ''on'', true);';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0058: het anker van de generatievlag past niet exact één keer.';
  end if;

  v_def := replace(v_def, v_anker,
    '  -- 0058: is deze periode door het kantoor op "niet van toepassing" gezet,' || E'\n' ||
    '  -- dan blijft ze weg. Een geannuleerde rij bezet haar slot niet -- dat is' || E'\n' ||
    '  -- met opzet, 0052 en 0053 steunen erop -- dus zonder deze controle zou' || E'\n' ||
    '  -- de volgende ronde de taak gewoon opnieuw aanmaken.' || E'\n' ||
    '  if exists (' || E'\n' ||
    '    select 1 from public.task_instances t' || E'\n' ||
    '    where t.client_id = p_client_id' || E'\n' ||
    '      and t.obligation_type_id = p_obligation_type_id' || E'\n' ||
    '      and t.periode_label is not distinct from p_periode_label' || E'\n' ||
    '      and t.niet_van_toepassing' || E'\n' ||
    '  ) then' || E'\n' ||
    '    return null;' || E'\n' ||
    '  end if;' || E'\n' ||
    '' || E'\n' ||
    v_anker);

  execute v_def;
end
$patch$;
