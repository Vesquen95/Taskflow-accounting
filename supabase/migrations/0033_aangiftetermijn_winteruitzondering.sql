-- ============================================================
-- 0033 — De aangiftetermijn: zevende maand, behalve bij een winterafsluiting
--
-- Gevonden bij het uitwerken van de RPB, die dezelfde termijnregel volgt.
--
-- De motor rekende sinds 0019 met "de laatste dag van de zevende maand na het
-- boekjaareinde" en niets meer. Die regel is onvolledig: sluit het boekjaar af
-- tussen 31 december en 28 februari, dan is de uiterste datum 30 september
-- (art. 310 WIB92; de termijn is er om de aangifte na het openen van Biztax te
-- kunnen indienen).
--
-- Wat dat betekende in de praktijk:
--
--   boekjaareinde   motor      werkelijk
--   31/12           31/07      30/09      fout, twee maanden te vroeg
--   31/01           31/08      30/09      fout
--   28/02           30/09      30/09      klopte toevallig
--   31/03           31/10      31/10      klopte
--   30/06           31/01      31/01      klopte
--   30/09           30/04      30/04      klopte
--
-- 31/12 is de meest voorkomende afsluitdatum, dus dit raakt het grootste deel
-- van het bestand. Te vroeg is de veilige kant -- je dient niet te laat in --
-- maar het vertekent de kalender en de werklastverdeling, en het is stil: er
-- verschijnt geen fout, de datum ziet er alleen maar plausibel uit.
--
-- Deze migratie doet drie dingen:
--   1. de regel in één functie zetten, zodat de VenB en de RPB (0034) niet
--      elk hun eigen versie krijgen;
--   2. de motor die functie laten gebruiken;
--   3. de taken die er al staan herberekenen -- anders geldt de correctie
--      alleen voor wat er nog gegenereerd moet worden, en dat is bij een
--      horizon van 36 maanden bijna niets.
--
-- De wettelijke kalender blijft bovenaan staan: is er voor dat jaar een
-- campagnedatum ingevuld, dan wint die van deze berekening. Dat verandert niet.
-- ============================================================

-- ------------------------------------------------------------
-- 1. De regel, op één plek
-- ------------------------------------------------------------
create or replace function public.aangifte_deadline(p_boekjaar_einde date)
returns date
language sql
immutable
set search_path = public
as $$
  select case
    -- Winterafsluiting: 31 december tot en met eind februari. Het jaar komt
    -- uit de basisberekening en klopt dan vanzelf -- een decemberafsluiting
    -- rekent naar het jaar erna, januari en februari naar hetzelfde jaar.
    when (extract(month from p_boekjaar_einde) = 12 and extract(day from p_boekjaar_einde) = 31)
      or extract(month from p_boekjaar_einde) in (1, 2)
    then make_date(
      extract(year from (date_trunc('month', p_boekjaar_einde) + interval '8 months' - interval '1 day'))::int,
      9, 30
    )
    -- De gewone regel: de laatste dag van de zevende maand na de maand van
    -- het boekjaareinde.
    else (date_trunc('month', p_boekjaar_einde) + interval '8 months' - interval '1 day')::date
  end;
$$;

revoke execute on function public.aangifte_deadline(date) from public, anon;

-- ------------------------------------------------------------
-- 2. De motor laat de regel over aan die functie
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
  v_aantal int;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'generate_task_instances_intern';

  if v_def is null then
    raise exception '0033: generate_task_instances_intern() bestaat niet.';
  end if;

  if position('aangifte_deadline' in v_def) > 0 then
    raise notice '0033: de motor gebruikt de functie al.';
    return;
  end if;

  v_anker :=
    '        -- Standaard: de laatste dag van de zevende maand na het boekjaareinde.' || E'\n' ||
    '        -- 31/12 -> 31/07, 30/06 -> 31/01, 30/09 -> 30/04, 31/03 -> 31/10.' || E'\n' ||
    '        v_due_raw := (date_trunc(''month'', v_be) + interval ''8 months'' - interval ''1 day'')::date;' || E'\n';

  v_aantal := (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker);
  if v_aantal <> 1 then
    raise exception '0033: anker % keer gevonden, verwacht 1.', v_aantal;
  end if;

  v_def := replace(
    v_def,
    v_anker,
    '        -- De wettelijke termijn: zie public.aangifte_deadline(). Eén plek,' || E'\n' ||
    '        -- want de RPB volgt exact dezelfde regel.' || E'\n' ||
    '        v_due_raw := public.aangifte_deadline(v_be);' || E'\n'
  );
  execute v_def;
end;
$patch$;

revoke execute on function public.generate_task_instances_intern(uuid, integer, integer, uuid)
  from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. De taken die er al staan
--
-- Alleen open, toekomstige, automatisch gegenereerde aangiftes. Werk dat af
-- of geannuleerd is blijft staan, en het verleden raken we niet aan: een
-- deadline die al gepasseerd is achteraf verzetten maakt de historiek onwaar.
--
-- Een handmatig afgesproken deadline wordt niet overschreven. Die krijgt de
-- nieuwe wettelijke datum plus een review, zodat iemand de afspraak nakijkt --
-- dezelfde regel als bij de AV en de jaarafsluiting.
-- ------------------------------------------------------------
do $herstel$
declare
  r record;
  v_nieuw date;
  v_lc date;
  v_actor uuid;
  v_aantal int := 0;
begin
  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.periode_eind, ti.due_date_handmatig_op,
           ti.review_reden, ti.obligation_type_id, c.firm_id, c.boekjaar_einde_maand
    from public.task_instances ti
    join public.clients c on c.id = ti.client_id
    join public.obligation_types ot on ot.id = ti.obligation_type_id
    where ot.code = 'aangifte_venb_pb'
      and ti.bron_type = 'automatisch_gegenereerd'
      and ti.status = 'open'
      and ti.due_date >= current_date
      and ti.periode_eind is not null
  loop
    v_nieuw := public.aangifte_deadline(r.periode_eind);

    -- De wettelijke kalender wint, net als in de motor.
    select deadline_datum into v_lc
    from public.legal_calendar
    where obligation_type_id = r.obligation_type_id
      and jaar = extract(year from r.periode_eind)::int
      and (scope = 'boekjaar_' || r.boekjaar_einde_maand or scope is null)
    order by is_override desc, updated_at desc
    limit 1;
    if v_lc is not null then
      v_nieuw := v_lc;
    end if;

    continue when v_nieuw is not distinct from r.due_date_wettelijk;

    -- task_status_log.actor_employee_id is not null en er is hier niemand
    -- ingelogd: de kantoorbeheerder van dat kantoor tekent ervoor, dezelfde
    -- terugval die de generator gebruikt.
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
            'De wettelijke aangiftetermijn is gecorrigeerd naar ' || to_char(v_nieuw, 'DD/MM/YYYY') ||
            '. Deze taak heeft een handmatig afgesproken deadline. Controleer of die afspraak nog klopt.'
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
      'De aangiftetermijn is gecorrigeerd: een boekjaar dat afsluit tussen 31 december en eind februari ' ||
      'valt op 30 september, niet op de laatste dag van de zevende maand.'
    );
    v_aantal := v_aantal + 1;
  end loop;

  raise notice '0033: % aangiftetaken herberekend.', v_aantal;
end;
$herstel$;
