-- 0074 — Uitstel tot 16 november na de cyberaanval bij de FOD Financiën
--
-- Gepubliceerd (29/10/2026): na de cyberaanval van 28/10 krijgen alle
-- aangiften die rond 31 oktober moesten worden ingediend uitstel tot maandag
-- 16 november 2026 (FOD Financiën, update cyberincident; ITAA-blog
-- 29/10/2026). Voor Taskflow raakt dat:
--   - de aangifte personenbelasting met specifieke inkomsten (scope
--     vorm_complex), die op 31/10/2026 stond (0073);
--   - de aangifte vennootschapsbelasting voor boekjaren die eindigen op
--     31/03/2026 -- vandaag heeft het kantoor er geen, maar de regel staat
--     erbij voor wie er later een krijgt;
--   - roerende voorheffing, Pillar 2, MDR/CBC en diverse taksen: geen
--     verplichtingen in Taskflow.
--
-- Hoe: zoals elke correctie van de wettelijke kalender een nieuwe
-- override-rij (de historiek blijft zichtbaar, §4.7), die de herberekening
-- (§3 punt 4) laat lopen voor de open taken.
--
-- Eén uitzondering op §3 punt 4: die herberekening laat taken die al in
-- behandeling zijn met rust. Voor een uitstel klopt dat niet -- de
-- wettelijke datum is gewoon later, en wie aan de taak werkt, hoort dat te
-- zien. Die taken worden hier één keer rechtgezet, langs de pijplijn en met
-- een regel in hun historiek. Een met de hand afgesproken deadline blijft
-- staan, zoals bij de herberekening zelf.

do $uitstel$
declare
  v_pb uuid;
  v_venb uuid;
  v_wie uuid;
  r record;
  v_bron constant text :=
    'FOD Financiën, update cyberincident 29/10/2026: aangiften met deadline 31/10/2026 uitstel tot 16/11/2026 (ook ITAA-blog 29/10/2026)';
begin
  select id into v_pb from public.obligation_types where code = 'aangifte_pb';
  select id into v_venb from public.obligation_types where code = 'aangifte_venb_pb';

  -- Wie de vorige override invoerde, voert ook deze in. Staat die er niet
  -- (een lege databank), dan is er niets uit te stellen.
  select aangemaakt_door into v_wie
  from public.legal_calendar
  where obligation_type_id = v_pb and jaar = 2025 and scope = 'vorm_complex'
    and is_override and deadline_datum = date '2026-10-31'
  order by updated_at desc
  limit 1;
  if v_wie is null then
    raise notice '0074: geen override van 31/10/2026 voor de PB gevonden; niets gewijzigd.';
    return;
  end if;

  -- 1. De personenbelasting met specifieke inkomsten.
  insert into public.legal_calendar (
    obligation_type_id, jaar, scope, deadline_datum, is_override, bron, aangemaakt_door, gewijzigd_door
  ) values (
    v_pb, 2025, 'vorm_complex', date '2026-11-16', true, v_bron, v_wie, v_wie
  );

  -- 2. De vennootschapsbelasting voor boekjaren die op 31 maart afsluiten
  -- (aanslagjaar 2026: jaar = het jaar waarin het boekjaar afsluit).
  if v_venb is not null then
    insert into public.legal_calendar (
      obligation_type_id, jaar, scope, deadline_datum, is_override, bron, aangemaakt_door, gewijzigd_door
    ) values (
      v_venb, 2026, 'boekjaar_3', date '2026-11-16', true, v_bron, v_wie, v_wie
    );
  end if;

  -- 3. Wat al in behandeling is: dezelfde datum, één keer.
  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.due_date_handmatig_op, ti.review_reden
    from public.task_instances ti
    join public.clients c on c.id = ti.client_id
    where ti.status in ('in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring')
      and (
        (ti.obligation_type_id = v_pb
          and extract(year from ti.periode_eind) = 2025
          and exists (
            select 1 from public.client_obligations co
            where co.id = ti.client_obligation_id
              and coalesce(co.parameters->>'aangifte_vorm', 'complex') = 'complex'
          ))
        or (ti.obligation_type_id = v_venb
          and extract(year from ti.periode_eind) = 2026
          and c.boekjaar_einde_maand = 3)
      )
      and ti.due_date_wettelijk < date '2026-11-16'
  loop
    perform set_config('taskflow.pipeline_task_id', r.id::text, true);
    if r.due_date_handmatig_op is not null then
      update public.task_instances
      set due_date_wettelijk = date '2026-11-16',
          verschuiving = 'geen',
          review_vereist = true,
          review_reden = coalesce(r.review_reden || ' — ', '') ||
            'Uitstel van de FOD tot 16/11/2026, maar deze taak heeft een handmatig afgesproken deadline. Controleer of die afspraak nog klopt.'
      where id = r.id;
    else
      update public.task_instances
      set due_date_wettelijk = date '2026-11-16', due_date = date '2026-11-16', verschuiving = 'geen'
      where id = r.id;
    end if;
    insert into public.task_status_log (
      task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
    ) values (
      r.id, 'due_date_herberekend', r.due_date_wettelijk, date '2026-11-16', v_wie, 'kalender_herberekening',
      'Uitstel van de FOD na de cyberaanval: 31/10 wordt 16/11/2026 (0074).'
    );
    perform set_config('taskflow.pipeline_task_id', '', true);
  end loop;
end
$uitstel$;
