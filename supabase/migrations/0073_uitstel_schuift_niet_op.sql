-- 0073 — Een uitstel schuift niet op
--
-- Gemeld (16/10/2026): de aangifte personenbelasting over 2025 stond op
-- maandag 2 november, terwijl het uitstel van de FOD 31 oktober zegt --
-- uitzonderlijk een zaterdag.
--
-- De uitzondering stond goed in de wettelijke kalender (31/10/2026, als
-- override). Maar de motor deed er daarna wat hij met elke berekende datum
-- doet: valt ze in een weekend of op een feestdag, dan naar de volgende
-- werkdag. Voor een eigen berekening ("16 oktober") is dat juist. Voor een
-- datum die de FOD zelf publiceert niet: die is al de beslissing, weekend of
-- niet. Wie op 2 november indient, is te laat.
--
-- De regel wordt dus: een override in de wettelijke kalender is een vaste
-- datum. Geen verschuiving, ook niet bij een latere feestdag. Een gewone
-- campagnedatum (geen override) en de eigen berekening blijven schuiven
-- zoals voorheen.
--
-- Hoe: de richting per taak (0048, 0065) krijgt een derde waarde, 'geen'.
--   1. de toegelaten waarden;
--   2. werkdatum(): 'geen' geeft de wettelijke datum zelf terug;
--   3. upsert_generated_task(): rekent via werkdatum() en bewaart 'geen';
--   4. kalender_verschuiving(): 'geen' als de datum uit een override komt;
--   5. de motor geeft die richting mee voor VenB/RPB en PB, de twee takken
--      die de wettelijke kalender raadplegen;
--   6. de herberekening bij een nieuwe override verschuift niet meer en zet
--      de richting op 'geen';
--   7. de transitietrigger laat de richting alleen door de pijplijn wijzigen
--      (tot nu toe door niemand);
--   8. de open taken die al op een verschoven datum stonden, worden recht
--      gezet.

-- ------------------------------------------------------------
-- 1. 'geen' als derde richting
-- ------------------------------------------------------------
alter table public.task_instances drop constraint task_instances_verschuiving_geldig;
alter table public.task_instances add constraint task_instances_verschuiving_geldig
  check (verschuiving in ('vooruit', 'terug', 'geen'));

-- ------------------------------------------------------------
-- 2. De werkdatum
-- ------------------------------------------------------------
create or replace function public.werkdatum(p_wettelijk date, p_verschuiving text)
returns date
language sql
stable
set search_path = public
as $$
  select case p_verschuiving
           when 'terug' then public.vorige_werkdag(p_wettelijk)
           -- 0073: een datum die de FOD publiceert, schuift niet.
           when 'geen' then p_wettelijk
           else public.next_business_day(p_wettelijk)
         end
$$;

-- ------------------------------------------------------------
-- 4. Komt deze datum uit een override?
-- ------------------------------------------------------------
create or replace function public.kalender_verschuiving(p_obligation_type_id uuid, p_jaar int, p_datum date)
returns text
language sql
stable
set search_path = public
as $$
  select case when exists (
    select 1 from public.legal_calendar
    where obligation_type_id = p_obligation_type_id
      and jaar = p_jaar
      and is_override
      and deadline_datum = p_datum
  ) then 'geen' else 'vooruit' end
$$;

revoke execute on function public.kalender_verschuiving(uuid, int, date) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3, 5, 6, 7. De functies, op hun plaats bijgewerkt
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  i int;
  v_ankers text[];
  v_nieuw text[];
begin
  -- Telkens: elk anker moet exact één keer staan, anders weigert de
  -- migratie. Zo kan ze nooit stil de verkeerde plek raken.
  -- 3. upsert_generated_task
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'upsert_generated_task';
  v_ankers := array[
    E'v_due date := case when p_verschuiving = ''terug''\n                     then public.vorige_werkdag(p_due_raw)\n                     else public.next_business_day(p_due_raw) end;',
    E'case when p_verschuiving = ''terug'' then ''terug'' else ''vooruit'' end'
  ];
  v_nieuw := array[
    E'v_due date := public.werkdatum(p_due_raw, p_verschuiving); -- 0073',
    E'case when p_verschuiving in (''terug'', ''geen'') then p_verschuiving else ''vooruit'' end'
  ];
  for i in 1 .. array_length(v_ankers, 1) loop
    if (length(v_def) - length(replace(v_def, v_ankers[i], ''))) / length(v_ankers[i]) <> 1 then
      raise exception '0073: anker % past niet exact één keer in upsert_generated_task().', i;
    end if;
    v_def := replace(v_def, v_ankers[i], v_nieuw[i]);
  end loop;
  execute v_def;

  -- 5. De motor: VenB/RPB en PB geven de richting mee.
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'generate_task_instances_intern';
  v_ankers := array[
    E'v_label, v_bstart, v_be, v_due_raw, v_default_employee, r_co.categorie\n        );\n      end loop;\n\n    elsif r_co.code = ''rapportering'' then',
    E'v_due_raw, v_default_employee, r_co.categorie\n        );\n      end loop;\n\n    elsif r_co.code in (''fiche_281_20'''
  ];
  v_nieuw := array[
    E'v_label, v_bstart, v_be, v_due_raw, v_default_employee, r_co.categorie,\n          p_verschuiving => public.kalender_verschuiving(r_co.obligation_type_id, v_year, v_due_raw) -- 0073\n        );\n      end loop;\n\n    elsif r_co.code = ''rapportering'' then',
    E'v_due_raw, v_default_employee, r_co.categorie,\n          p_verschuiving => public.kalender_verschuiving(r_co.obligation_type_id, v_year, v_due_raw) -- 0073\n        );\n      end loop;\n\n    elsif r_co.code in (''fiche_281_20'''
  ];
  for i in 1 .. array_length(v_ankers, 1) loop
    if (length(v_def) - length(replace(v_def, v_ankers[i], ''))) / length(v_ankers[i]) <> 1 then
      raise exception '0073: anker % past niet exact één keer in generate_task_instances_intern().', i;
    end if;
    v_def := replace(v_def, v_ankers[i], v_nieuw[i]);
  end loop;
  execute v_def;

  -- 6. De herberekening bij een nieuwe override.
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'recalc_due_dates_on_legal_calendar_override';
  v_ankers := array[
    E'v_new_due := public.next_business_day(new.deadline_datum);',
    E'set due_date_wettelijk = new.deadline_datum,\n            review_vereist = true,',
    E'set due_date_wettelijk = new.deadline_datum, due_date = v_new_due\n'
  ];
  v_nieuw := array[
    E'-- 0073: een override is een vaste datum, ook in het weekend.\n    v_new_due := new.deadline_datum;',
    E'set due_date_wettelijk = new.deadline_datum,\n            verschuiving = ''geen'',\n            review_vereist = true,',
    E'set due_date_wettelijk = new.deadline_datum, due_date = v_new_due, verschuiving = ''geen''\n'
  ];
  for i in 1 .. array_length(v_ankers, 1) loop
    if (length(v_def) - length(replace(v_def, v_ankers[i], ''))) / length(v_ankers[i]) <> 1 then
      raise exception '0073: anker % past niet exact één keer in recalc_due_dates_on_legal_calendar_override().', i;
    end if;
    v_def := replace(v_def, v_ankers[i], v_nieuw[i]);
  end loop;
  execute v_def;

  -- 7. De richting: alleen de pijplijn mag ze nog wijzigen.
  select pg_get_functiondef(oid) into v_def from pg_proc where proname = 'enforce_task_instance_transition';
  v_ankers := array[E'  new.verschuiving := old.verschuiving;\n'];
  v_nieuw := array[E'  -- 0073: behalve wanneer de herberekening van een override haar zet.\n  if not v_pipeline then\n    new.verschuiving := old.verschuiving;\n  end if;\n'];
  if (length(v_def) - length(replace(v_def, v_ankers[1], ''))) / length(v_ankers[1]) <> 1 then
    raise exception '0073: het anker past niet exact één keer in enforce_task_instance_transition().';
  end if;
  execute replace(v_def, v_ankers[1], v_nieuw[1]);
end
$patch$;

-- ------------------------------------------------------------
-- 8. Wat al verschoven stond, recht zetten
--
-- Open taken waarvan de wettelijke datum een override is, en die niet met
-- de hand verzet werden. Langs de pijplijn, met een regel in de historiek.
-- ------------------------------------------------------------
do $fix$
declare
  r record;
begin
  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk
    from public.task_instances ti
    where ti.status = 'open'
      and ti.due_date_handmatig_op is null
      and exists (
        select 1 from public.legal_calendar l
        where l.obligation_type_id = ti.obligation_type_id
          and l.is_override
          and l.deadline_datum = ti.due_date_wettelijk
          and l.jaar = extract(year from ti.periode_eind)::int
      )
      and (ti.due_date is distinct from ti.due_date_wettelijk or ti.verschuiving <> 'geen')
  loop
    perform set_config('taskflow.pipeline_task_id', r.id::text, true);
    update public.task_instances
    set due_date = r.due_date_wettelijk, verschuiving = 'geen'
    where id = r.id;
    if r.due_date is distinct from r.due_date_wettelijk then
      insert into public.task_status_log (
        task_instance_id, event_type, oude_due_date, nieuwe_due_date, trigger_bron, notitie
      ) values (
        r.id, 'due_date_herberekend', r.due_date, r.due_date_wettelijk, 'kalender_herberekening',
        'Uitstel van de FOD is een vaste datum, ook in het weekend: niet langer naar de volgende werkdag verschoven (0073).'
      );
    end if;
    perform set_config('taskflow.pipeline_task_id', '', true);
  end loop;
end
$fix$;
