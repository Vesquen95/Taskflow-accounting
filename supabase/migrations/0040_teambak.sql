-- ============================================================
-- 0040 — De teambak: een taak mag op naam van het team staan
--
-- "De teams zijn verantwoordelijk voor de taken, niet per se één persoon."
-- Tot nu was toegewezen_medewerker_id verplicht: elke taak droeg een naam,
-- ook wanneer nog niemand ze opgenomen had. Dat leverde twee onwaarheden op:
--
--   * De taakgeneratie viel terug op "de oudste actieve kantoorbeheerder"
--     wanneer een dossier geen verantwoordelijke had. Zo stond er werk op
--     iemands naam dat hij nooit gekregen had.
--   * Vond ze zelfs die niet, dan sloeg ze het hele dossier over. Stil. Een
--     klant zonder taken zag er dan uit als een klant zonder verplichtingen.
--
-- Vanaf nu mag de naam leeg blijven. De taak ligt dan in de bak van het team
-- dat het dossier draait (0038/0039), en wie ze oppakt zet er zijn naam op.
-- Geen terugval op een willekeurige collega, en geen overgeslagen dossier.
--
-- task_status_log.actor_employee_id gaat mee: die kolom was verplicht en werd
-- daarom soms met de toegewezen medewerker gevuld terwijl die niets gedaan
-- had. Bij een automatische herberekening is er gewoon geen mens aan de
-- knoppen, en dan is "leeg" het eerlijke antwoord.
-- ============================================================

alter table public.task_instances
  alter column toegewezen_medewerker_id drop not null;

comment on column public.task_instances.toegewezen_medewerker_id is
  'Wie deze taak op zich genomen heeft. Leeg = nog niemand: de taak ligt in de bak van het team dat het dossier draait.';

alter table public.task_status_log
  alter column actor_employee_id drop not null;

comment on column public.task_status_log.actor_employee_id is
  'Wie de actie deed. Leeg betekent dat er geen mens aan de knoppen stond: een automatische herberekening of een taakgeneratie zonder ingelogde medewerker. Beter leeg dan een naam die niets gedaan heeft.';

-- ------------------------------------------------------------
-- 1. De kantoorgrens bij het aanmaken
--
-- Geen naam is geen fout. Staat er wel een naam, dan moet die nog altijd bij
-- hetzelfde kantoor horen als de klant.
-- ------------------------------------------------------------
create or replace function public.enforce_task_assignment_firm_on_insert()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_emp_firm uuid;
  v_client_firm uuid;
begin
  if new.toegewezen_medewerker_id is null then
    return new;
  end if;
  select firm_id into v_emp_firm from public.employees where id = new.toegewezen_medewerker_id;
  select firm_id into v_client_firm from public.clients where id = new.client_id;
  if v_emp_firm is null or v_client_firm is null or v_emp_firm <> v_client_firm then
    raise exception 'De toegewezen medewerker hoort niet bij het kantoor van deze klant'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_task_assignment_firm_on_insert() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Terugleggen in de teambak
--
-- Twee stukjes van enforce_task_instance_transition() worden geraakt, en
-- allebei moeten ze exact één keer passen. De rest van die functie -- de
-- statusmachine, de bevroren kolommen, de audit -- blijft ongemoeid; ze
-- overtypen zou een eerdere correctie ongedaan kunnen maken.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
  v_nieuw text;
  v_aantal int;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'enforce_task_instance_transition';

  if v_def is null then
    raise exception '0040: enforce_task_instance_transition() bestaat niet.';
  end if;

  -- (a) De kantoorgrens: overslaan wanneer de taak teruggelegd wordt.
  v_anker :=
    '    select firm_id into v_emp_firm from public.employees where id = new.toegewezen_medewerker_id;' || E'\n' ||
    '    select firm_id, vertrouwelijk into v_client_firm, v_vertrouwelijk' || E'\n' ||
    '    from public.clients where id = new.client_id;' || E'\n' ||
    '    if v_emp_firm is null or v_client_firm is null or v_emp_firm <> v_client_firm then';

  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0040: anker (a) past niet exact één keer in enforce_task_instance_transition().';
  end if;

  v_nieuw :=
    '    select firm_id into v_emp_firm from public.employees where id = new.toegewezen_medewerker_id;' || E'\n' ||
    '    select firm_id, vertrouwelijk into v_client_firm, v_vertrouwelijk' || E'\n' ||
    '    from public.clients where id = new.client_id;' || E'\n' ||
    '    -- 0040: leeg maken is de taak teruggeven aan het team. Dan valt er' || E'\n' ||
    '    -- geen kantoorgrens te overschrijden.' || E'\n' ||
    '    if new.toegewezen_medewerker_id is not null' || E'\n' ||
    '       and (v_emp_firm is null or v_client_firm is null or v_emp_firm <> v_client_firm) then';

  v_def := replace(v_def, v_anker, v_nieuw);

  -- (b) De logregel. "Herverdeeld van medewerker <leeg>" leest als een fout;
  --     opnemen en terugleggen zijn eigen gebeurtenissen en horen zo te heten.
  v_anker :=
    '        format(''Herverdeeld van medewerker %s naar %s'', old.toegewezen_medewerker_id, new.toegewezen_medewerker_id)';

  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0040: anker (b) past niet exact één keer in enforce_task_instance_transition().';
  end if;

  v_nieuw :=
    '        case' || E'\n' ||
    '          when new.toegewezen_medewerker_id is null then' || E'\n' ||
    '            format(''Teruggelegd in de bak van het team door medewerker %s'', v_actor)' || E'\n' ||
    '          when old.toegewezen_medewerker_id is null then' || E'\n' ||
    '            format(''Opgenomen uit de bak van het team door medewerker %s'', new.toegewezen_medewerker_id)' || E'\n' ||
    '          else' || E'\n' ||
    '            format(''Herverdeeld van medewerker %s naar %s'', old.toegewezen_medewerker_id, new.toegewezen_medewerker_id)' || E'\n' ||
    '        end';

  v_def := replace(v_def, v_anker, v_nieuw);

  execute v_def;
end $patch$;

-- ------------------------------------------------------------
-- 3. De taakgeneratie slaat niemand meer over
--
-- Weg met de terugval op de eerste de beste kantoorbeheerder, en weg met het
-- overslaan van een dossier. Vindt de motor geen verantwoordelijke, dan komt
-- de taak er gewoon -- zonder naam, in de bak van het team.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
  v_nieuw text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'generate_task_instances_intern';

  if v_def is null then
    raise exception '0040: generate_task_instances_intern() bestaat niet.';
  end if;

  v_anker :=
    '    select coalesce(' || E'\n' ||
    '      r_co.standaard_toegewezen_medewerker_id,' || E'\n' ||
    '      r_co.standaard_verantwoordelijke_id,' || E'\n' ||
    '      (' || E'\n' ||
    '        select e.id from public.employees e' || E'\n' ||
    '        where e.firm_id = r_co.firm_id and e.rol = ''kantoorbeheerder'' and e.actief' || E'\n' ||
    '        order by e.created_at asc limit 1' || E'\n' ||
    '      )' || E'\n' ||
    '    ) into v_default_employee;';

  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0040: het anker van de standaardverantwoordelijke past niet exact één keer.';
  end if;

  v_nieuw :=
    '    -- 0040: geen terugval meer op een willekeurige kantoorbeheerder. Is er' || E'\n' ||
    '    -- niemand aangeduid, dan blijft de taak zonder naam en ligt ze in de' || E'\n' ||
    '    -- bak van het team dat het dossier draait.' || E'\n' ||
    '    select coalesce(' || E'\n' ||
    '      r_co.standaard_toegewezen_medewerker_id,' || E'\n' ||
    '      r_co.standaard_verantwoordelijke_id' || E'\n' ||
    '    ) into v_default_employee;';

  v_def := replace(v_def, v_anker, v_nieuw);

  -- En het overslaan zelf. De tekst hangt aan de oude reden, dus het anker
  -- bevat het commentaar: past het niet meer, dan is die reden veranderd en
  -- moet iemand hier opnieuw naar kijken.
  v_anker :=
    '    -- toegewezen_medewerker_id is NOT NULL; if a firm somehow has no' || E'\n' ||
    '    -- active kantoorbeheerder and no default responsible configured at' || E'\n' ||
    '    -- all, we cannot safely invent an assignee — skip rather than fail' || E'\n' ||
    '    -- the whole run for every other client.' || E'\n' ||
    '    if v_default_employee is null then' || E'\n' ||
    '      continue;' || E'\n' ||
    '    end if;' || E'\n';

  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0040: het anker van de overgeslagen klant past niet exact één keer.';
  end if;

  v_def := replace(v_def, v_anker, '');

  execute v_def;
end $patch$;

-- De rechten van de motor blijven zoals ze stonden: alleen de wrapper is voor
-- ingelogde medewerkers, de interne functie niet.
revoke execute on function public.generate_task_instances_intern(uuid, integer, integer, uuid)
  from public, anon, authenticated;
