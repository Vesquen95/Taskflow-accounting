-- ============================================================
-- 0049 — Fiche 281.50 valt op 29 juni, niet op 30 juni
--
-- Tweede vondst van het fiscale nazicht van 04/09/2026.
--
-- De wet zegt "vóór 30 juni". Migratie 0028 heeft dat gelezen als "op 30
-- juni", en dat is er één te ver: vóór 30 juni is ten laatste 29 juni. De FOD
-- publiceert het ook zo. Voor inkomstenjaar 2025 stond het overal aangekondigd
-- als "uiterlijk op maandag 29 juni 2026".
--
-- Dezelfde valstrik zit niet bij de fiches 281.20 en 281.45: die rekent 0028
-- als "1 maart min een dag", wat eind februari oplevert en dus wél klopt --
-- inclusief 29 februari in een schrikkeljaar.
--
-- ------------------------------------------------------------
-- Wat hier NIET beslist wordt
--
-- Of een Belcotax-fiche opschuift wanneer de uiterste dag in het weekend
-- valt. De FOD publiceert vaste dagen en zegt er niets over. 29 juni 2026 is
-- een maandag, dus dit jaar maakt het niet uit; 29 juni 2030 is een zaterdag
-- en dan wel. De motor laat de verschuiving vooruit staan zoals ze was --
-- niet omdat dat bewezen juist is, maar omdat het veranderen op een gok
-- erger zou zijn dan het laten staan. Dit is een vraag voor het kantoor.
-- ============================================================

do $patch$
declare
  v_def text;
  v_anker text;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'generate_task_instances_intern';

  if v_def is null then
    raise exception '0049: generate_task_instances_intern() bestaat niet.';
  end if;

  v_anker := '          v_due_raw := make_date(v_year + 1, 6, 30);';
  if (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker) <> 1 then
    raise exception '0049: het anker van de 281.50-datum past niet exact één keer (%).',
      (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker);
  end if;

  v_def := replace(v_def, v_anker,
    '          -- 0049: "vóór 30 juni" is ten laatste de 29ste, en zo publiceert' || E'\n' ||
    '          -- de FOD het ook.' || E'\n' ||
    '          v_due_raw := make_date(v_year + 1, 6, 29);');

  execute v_def;
end
$patch$;

-- ------------------------------------------------------------
-- De taken die er al staan
--
-- Zelfde patroon als 0017, 0033 en 0048. Alleen wat nog moet gebeuren: een
-- gepasseerde deadline achteraf verzetten maakt de historiek onwaar.
-- ------------------------------------------------------------
do $herstel$
declare
  r record;
  v_nieuw date;
  v_actor uuid;
  v_aantal int := 0;
begin
  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.due_date_handmatig_op,
           ti.review_reden, c.firm_id
    from public.task_instances ti
    join public.clients c on c.id = ti.client_id
    join public.obligation_types ot on ot.id = ti.obligation_type_id
    where ot.code = 'fiche_281_50'
      and ti.status not in ('ingediend_afgerond', 'geannuleerd')
      and ti.due_date_wettelijk >= current_date
      and extract(month from ti.due_date_wettelijk) = 6
      and extract(day from ti.due_date_wettelijk) = 30
  loop
    v_nieuw := r.due_date_wettelijk - 1;

    select e.id into v_actor
    from public.employees e
    where e.firm_id = r.firm_id and e.rol = 'kantoorbeheerder' and e.actief
    order by e.created_at asc
    limit 1;
    continue when v_actor is null;

    perform set_config('taskflow.pipeline_task_id', r.id::text, true);
    if r.due_date_handmatig_op is not null then
      update public.task_instances
      set due_date_wettelijk = v_nieuw,
          review_vereist = true,
          review_reden = coalesce(r.review_reden || ' — ', '') ||
            'De uiterste datum voor fiche 281.50 is gecorrigeerd naar ' ||
            to_char(v_nieuw, 'DD/MM/YYYY') || ' ("vóór 30 juni" is ten laatste de 29ste). ' ||
            'Deze taak heeft een handmatig afgesproken deadline; controleer of die nog klopt.'
      where id = r.id;
    else
      update public.task_instances
      set due_date_wettelijk = v_nieuw,
          due_date = public.next_business_day(v_nieuw)
      where id = r.id;
    end if;
    perform set_config('taskflow.pipeline_task_id', '', true);

    insert into public.task_status_log (
      task_instance_id, event_type, oude_due_date, nieuwe_due_date,
      actor_employee_id, trigger_bron, notitie
    ) values (
      r.id, 'due_date_herberekend', r.due_date, public.next_business_day(v_nieuw),
      v_actor, 'kalender_herberekening',
      'De uiterste indieningsdatum voor fiche 281.50 is "vóór 30 juni", dus ten laatste de 29ste. ' ||
      'De motor rekende een dag te ver.'
    );
    v_aantal := v_aantal + 1;
  end loop;

  raise notice '0049: % taken voor fiche 281.50 herberekend.', v_aantal;
end
$herstel$;
