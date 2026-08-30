-- ============================================================
-- 0030 — Een gewijzigde jaarafsluiting verzet ook de taken die er al staan
--
-- 0029 gaf de jaarafsluiting een tweede manier van rekenen, maar alleen voor
-- taken die nog gegenereerd moeten worden. upsert_generated_task() doet
-- `on conflict do nothing`: een taak die er al staat behoudt haar deadline.
-- Voor een dossier dat vandaag draait -- en dat zijn ze allemaal -- betekende
-- dat: je zet de jaarafsluiting op "een maand voor de AV", je slaat op, en er
-- verandert niets. De instelling stond er wel, de kalender volgde niet.
--
-- De algemene vergadering had dit al opgelost (herbereken_av_taken, 0020).
-- Deze migratie doet hetzelfde voor de jaarafsluiting, en verbindt de twee:
--
--  1. De parameters van de jaarafsluiting wijzigen  -> herberekenen.
--  2. De statutaire AV-datum wijzigen               -> herberekenen, want een
--     jaarafsluiting op 'voor_av' hangt aan die datum. Zonder deze tweede weg
--     zou de AV verschuiven en de afsluiting blijven staan -- precies het
--     uiteenlopen dat 0029 wilde voorkomen.
--
-- Een handmatig afgesproken deadline (due_date_handmatig_op) wordt nooit
-- stilzwijgend overschreven: die krijgt de nieuwe wettelijke datum plus een
-- review, zodat iemand de afspraak nakijkt. Zelfde regel als bij de AV.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Het herberekenen zelf
--
-- Een aparte functie en niet twee keer dezelfde tekst in twee triggers: de
-- berekening moet op één plek staan, anders lopen de twee wegen na de eerste
-- correctie uit elkaar.
-- ------------------------------------------------------------
create or replace function public.herbereken_jaarafsluiting_taken_voor(p_client_id uuid)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
  v_ot_jaarafsluiting uuid;
  v_parameters jsonb;
  v_basis text;
  v_sla_maanden int;
  v_maanden_voor_av int;
  v_av_parameters jsonb;
  v_av_due date;
  v_nieuw date;
  v_aantal int := 0;
  r record;
begin
  select id into v_ot_jaarafsluiting from public.obligation_types where code = 'jaarafsluiting';
  if v_ot_jaarafsluiting is null then
    return 0;
  end if;

  select co.parameters into v_parameters
  from public.client_obligations co
  where co.client_id = p_client_id
    and co.obligation_type_id = v_ot_jaarafsluiting
    and co.actief
    and co.geldig_vanaf <= current_date
    and (co.geldig_tot is null or co.geldig_tot >= current_date)
  order by co.created_at desc
  limit 1;

  -- Geen lopende jaarafsluiting: niets te herberekenen.
  if v_parameters is null then
    return 0;
  end if;

  v_basis := coalesce(v_parameters->>'basis', 'boekjaar');
  v_sla_maanden := coalesce((v_parameters->>'sla_maanden')::int, 3);
  v_maanden_voor_av := coalesce((v_parameters->>'maanden_voor_av')::int, 1);

  if v_basis = 'voor_av' then
    select co.parameters into v_av_parameters
    from public.client_obligations co
    join public.obligation_types ot on ot.id = co.obligation_type_id
    where co.client_id = p_client_id
      and ot.code = 'algemene_vergadering'
      and co.actief
    order by co.created_at desc
    limit 1;
  end if;

  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.periode_eind,
           ti.due_date_handmatig_op, ti.review_reden
    from public.task_instances ti
    where ti.client_id = p_client_id
      and ti.obligation_type_id = v_ot_jaarafsluiting
      and ti.bron_type = 'automatisch_gegenereerd'
      and ti.status = 'open'
      and ti.due_date >= current_date
  loop
    -- periode_eind van een jaarafsluitingstaak is het boekjaareinde: zo zet de
    -- generator ze weg. Zelfde rekenwerk als daar, anders zeggen de twee iets
    -- anders over dezelfde taak.
    if v_basis = 'voor_av' then
      v_av_due := coalesce(public.av_datum(r.periode_eind, v_av_parameters),
                           (r.periode_eind + interval '6 months')::date);
      v_nieuw := (v_av_due - (v_maanden_voor_av || ' months')::interval)::date;
      if v_nieuw < r.periode_eind then
        v_nieuw := r.periode_eind;
      end if;
    else
      v_nieuw := (r.periode_eind + (v_sla_maanden || ' months')::interval)::date;
    end if;

    continue when v_nieuw is not distinct from r.due_date_wettelijk;

    perform set_config('taskflow.pipeline_task_id', r.id::text, true);
    if r.due_date_handmatig_op is not null then
      update public.task_instances
      set due_date_wettelijk = v_nieuw,
          review_vereist = true,
          review_reden = coalesce(r.review_reden || ' — ', '') ||
            'De berekening van de jaarafsluiting is gewijzigd; de wettelijke datum wordt ' ||
            to_char(v_nieuw, 'DD/MM/YYYY') ||
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
      case when v_basis = 'voor_av'
        then 'De jaarafsluiting wordt nu ' || v_maanden_voor_av ||
             ' maand(en) voor de algemene vergadering gepland; de deadline staat op ' ||
             to_char(v_nieuw, 'DD/MM/YYYY') || '.'
        else 'De jaarafsluiting wordt nu ' || v_sla_maanden ||
             ' maand(en) na het boekjaareinde gepland; de deadline staat op ' ||
             to_char(v_nieuw, 'DD/MM/YYYY') || '.'
      end
    );
    v_aantal := v_aantal + 1;
  end loop;

  return v_aantal;
end;
$$;

revoke execute on function public.herbereken_jaarafsluiting_taken_voor(uuid) from public, anon;

-- ------------------------------------------------------------
-- 2. Weg 1: de parameters van de jaarafsluiting wijzigen
-- ------------------------------------------------------------
create or replace function public.herbereken_jaarafsluiting_taken()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_code text;
  v_aantal int;
begin
  select code into v_code from public.obligation_types where id = new.obligation_type_id;
  if v_code is distinct from 'jaarafsluiting' then
    return new;
  end if;
  if new.parameters is not distinct from old.parameters then
    return new;
  end if;

  v_aantal := public.herbereken_jaarafsluiting_taken_voor(new.client_id);

  if v_aantal > 0 then
    insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
    values (new.client_id, 'jaarafsluiting_berekening',
            old.parameters::text, new.parameters::text, public.current_employee_id());
  end if;

  return new;
end;
$$;

drop trigger if exists trg_client_obligations_jaarafsluiting_herbereken on public.client_obligations;
create trigger trg_client_obligations_jaarafsluiting_herbereken
  after update of parameters on public.client_obligations
  for each row execute function public.herbereken_jaarafsluiting_taken();

-- ------------------------------------------------------------
-- 3. Weg 2: de statutaire AV-datum wijzigen
--
-- herbereken_av_taken() krijgt er één aanroep bij. Patchen in plaats van
-- overtypen, zodat de rest van die functie -- inclusief het bijwerken van de
-- neerlegging -- letterlijk blijft staan.
-- ------------------------------------------------------------
do $patch$
declare
  v_def text;
  v_anker text;
  v_aantal int;
begin
  select pg_get_functiondef(oid) into v_def
  from pg_proc where proname = 'herbereken_av_taken';

  if v_def is null then
    raise exception '0030: herbereken_av_taken() bestaat niet.';
  end if;

  if position('herbereken_jaarafsluiting_taken_voor' in v_def) > 0 then
    raise notice '0030: de aanroep staat er al.';
    return;
  end if;

  v_anker :=
    '            old.parameters::text, new.parameters::text, v_actor);' || E'\n' ||
    '  end if;' || E'\n' ||
    E'\n' ||
    '  return new;';
  v_aantal := (length(v_def) - length(replace(v_def, v_anker, ''))) / length(v_anker);
  if v_aantal <> 1 then
    raise exception '0030: anker % keer gevonden in herbereken_av_taken(), verwacht 1.', v_aantal;
  end if;

  v_def := replace(
    v_def,
    v_anker,
    '            old.parameters::text, new.parameters::text, v_actor);' || E'\n' ||
    '  end if;' || E'\n' ||
    E'\n' ||
    '  -- Een jaarafsluiting die op ''voor_av'' staat hangt aan deze datum en moet' || E'\n' ||
    '  -- mee opschuiven; staat ze op ''boekjaar'', dan doet dit niets.' || E'\n' ||
    '  perform public.herbereken_jaarafsluiting_taken_voor(new.client_id);' || E'\n' ||
    E'\n' ||
    '  return new;'
  );
  execute v_def;
end;
$patch$;
