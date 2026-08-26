-- Taskflow v1 — twee correcties aan de deadlineberekening, bevestigd door het
-- kantoor.
--
-- 1. BTW-kwartaalaangifte lag vijf dagen te vroeg. Beide takken van de
--    btw-generatie rekenden `+ 19` (de 20ste van de maand na de periode). Dat
--    klopt voor de maandaangifte, maar de kwartaalaangifte valt op de 25ste.
--    Gevolg: elke kwartaaldeadline in het systeem stond op de 20ste, dus het
--    kantoor joeg klanten vijf dagen te vroeg op en de werklastverdeling
--    klopte niet.
--
-- 2. Voorafbetalingen worden nu vanaf het boekjaarEINDE gerekend. De oude
--    formule ankerde op het boekjaarbegin (afgeleid als einde - 1 jaar + 1
--    dag) en veronderstelde dus altijd een boekjaar van exact twaalf maanden.
--    Bij een eerste, laatste of verlengd boekjaar liep het schema daardoor
--    scheep. Voor een gewoon boekjaar verandert er niets: 31/12 geeft nog
--    steeds 10/4, 10/7, 10/10 en 20/12; bij 31/3, 30/6 of 30/9 schuift het
--    hele schema mee.
--
-- Uitdrukkelijke keuze van het kantoor, hier vastgelegd zodat een latere
-- lezer ze niet per ongeluk terugdraait:
--   * De verschuiving naar de eerstvolgende werkdag blijft voor ALLE
--     btw-aangiften gelden, maand zowel als kwartaal. De maand/kwartaal-
--     splitsing en de overgangsregels uit de hervorming van de btw-ketting
--     worden bewust NIET gemodelleerd ("hou geen rekening met speciale
--     maatregelen"). Eenmalige verlengingen horen in legal_calendar als
--     override, niet in deze formule.
--   * Er is geen vijfde voorafbetaling. VA1-VA4 is volledig.
--   * De btw-klantenlisting geldt ook voor de vrijgestelde kleine onderneming
--     (art. 56bis), die haar omzet via de listing moet doorgeven. De
--     bestaande regel btw_regime <> 'geen' is dus correct en blijft.
--
-- Additief: 0003-0016 zijn al toegepast en worden NIET gewijzigd. De functie
-- hieronder is de versie uit 0016, ongewijzigd op de twee blokken hierboven na.

CREATE OR REPLACE FUNCTION public.generate_task_instances(p_horizon_months integer DEFAULT 3, p_backfill_months integer DEFAULT 6)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := public.current_employee_id();
  v_firm_id uuid := public.current_employee_firm_id();
  v_window_start date := current_date - (p_backfill_months || ' months')::interval;
  v_window_end date := current_date + (p_horizon_months || ' months')::interval;
  v_gen_from date := v_window_start - interval '6 months';
  v_before_count bigint;
  v_after_count bigint;

  r_co record;
  v_default_employee uuid;

  v_ot_neerlegging uuid;

  v_period_start date;
  v_period_eind date;
  v_due_raw date;
  v_label text;
  v_year int;
  v_be date;
  v_bstart date;
  v_i int;
  v_month_offset int;
  v_day int;
  v_sla_maanden int;
  v_av_id uuid;
  v_scope text;
  v_lc_date date;
  v_frequentie text;
  v_termijn_dagen int;
  v_new_id uuid;
begin
  if v_actor is null or v_firm_id is null or not public.is_kantoorbeheerder() then
    raise exception 'Alleen een kantoorbeheerder kan taakgeneratie starten';
  end if;

  -- Weigeren i.p.v. stil afkappen: wie 120 typt waar 12 bedoeld was, hoort
  -- dat te weten. Negatieve waarden leverden voorheen stil nul taken op.
  if p_horizon_months is null or p_horizon_months < 0 or p_horizon_months > 36 then
    raise exception
      'De generatiehorizon moet tussen 0 en 36 maanden vooruit liggen (gevraagd: %).',
      coalesce(p_horizon_months::text, 'niets')
      using errcode = 'check_violation';
  end if;
  if p_backfill_months is null or p_backfill_months < 0 or p_backfill_months > 24 then
    raise exception
      'Het inhaalvenster moet tussen 0 en 24 maanden terug liggen (gevraagd: %).',
      coalesce(p_backfill_months::text, 'niets')
      using errcode = 'check_violation';
  end if;

  select id into v_ot_neerlegging from public.obligation_types where code = 'neerlegging_jaarrekening';
  select count(*) into v_before_count from public.task_instances where bron_type = 'automatisch_gegenereerd';

  for r_co in
    select
      co.id as client_obligation_id, co.client_id, co.parameters,
      co.standaard_toegewezen_medewerker_id,
      c.firm_id, c.actief as client_actief,
      c.btw_regime, c.btw_aangifte_frequentie,
      c.boekjaar_einde_maand, c.boekjaar_einde_dag,
      c.standaard_verantwoordelijke_id,
      ot.id as obligation_type_id, ot.code, ot.categorie
    from public.client_obligations co
    join public.clients c on c.id = co.client_id
    join public.obligation_types ot on ot.id = co.obligation_type_id
    where co.actief
      and c.actief
      and c.firm_id = v_firm_id
      and co.geldig_vanaf <= current_date
      and (co.geldig_tot is null or co.geldig_tot >= current_date)
  loop
    select coalesce(
      r_co.standaard_toegewezen_medewerker_id,
      r_co.standaard_verantwoordelijke_id,
      (
        select e.id from public.employees e
        where e.firm_id = r_co.firm_id and e.rol = 'kantoorbeheerder' and e.actief
        order by e.created_at asc limit 1
      )
    ) into v_default_employee;

    -- toegewezen_medewerker_id is NOT NULL; if a firm somehow has no
    -- active kantoorbeheerder and no default responsible configured at
    -- all, we cannot safely invent an assignee — skip rather than fail
    -- the whole run for every other client.
    if v_default_employee is null then
      continue;
    end if;

    if r_co.code = 'btw_aangifte' then
      if r_co.btw_regime = 'periodieke_aangever' and r_co.btw_aangifte_frequentie is not null then
        if r_co.btw_aangifte_frequentie = 'maand' then
          for v_period_start in
            select generate_series(date_trunc('month', v_gen_from), date_trunc('month', v_window_end), interval '1 month')::date
          loop
            v_period_eind := (v_period_start + interval '1 month' - interval '1 day')::date;
            v_due_raw := (date_trunc('month', v_period_eind) + interval '1 month')::date + 19;
            continue when v_due_raw < v_window_start or v_due_raw > v_window_end;
            v_label := to_char(v_period_start, 'YYYY-MM');
            v_new_id := public.upsert_generated_task(
              r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
              v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie
            );
          end loop;
        else
          for v_period_start in
            select generate_series(date_trunc('quarter', v_gen_from), date_trunc('quarter', v_window_end), interval '3 months')::date
          loop
            v_period_eind := (v_period_start + interval '3 months' - interval '1 day')::date;
            -- Kwartaalaangifte: de 25ste van de maand na het kwartaal.
            -- Stond op + 19 (de 20ste, de maandtermijn) en lag dus vijf dagen te vroeg.
            v_due_raw := (date_trunc('month', v_period_eind) + interval '1 month')::date + 24;
            continue when v_due_raw < v_window_start or v_due_raw > v_window_end;
            v_label := to_char(v_period_start, 'YYYY') || '-Q' || to_char(v_period_start, 'Q');
            v_new_id := public.upsert_generated_task(
              r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
              v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie
            );
          end loop;
        end if;
      end if;

    elsif r_co.code = 'va_venb' then
      for v_year in
        extract(year from v_window_start)::int - 1 .. extract(year from v_window_end)::int + 1
      loop
        v_be := public.fiscal_year_end(r_co.boekjaar_einde_maand, r_co.boekjaar_einde_dag, v_year);
        v_bstart := (v_be - interval '1 year' + interval '1 day')::date;
        for v_i in 1..4 loop
          -- Terugrekenen vanaf de maand van het boekjaareinde: bij 31/12 geeft
          -- dat 10/4, 10/7, 10/10 en 20/12, en bij 31/3, 30/6 of 30/9 schuift
          -- het hele schema mee. Ankeren op het boekjaarBEGIN deed dat ook,
          -- maar veronderstelde altijd een boekjaar van exact twaalf maanden.
          v_month_offset := case v_i when 1 then -8 when 2 then -5 when 3 then -2 else 0 end;
          v_day := case v_i when 4 then 20 else 10 end;
          v_due_raw := (date_trunc('month', v_be) + (v_month_offset || ' months')::interval)::date + (v_day - 1);
          continue when v_due_raw < v_window_start or v_due_raw > v_window_end;
          v_label := 'VA' || v_i || '-' || to_char(v_be, 'YYYY');
          v_new_id := public.upsert_generated_task(
            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
            v_label, v_bstart, v_be, v_due_raw, v_default_employee, r_co.categorie
          );
        end loop;
      end loop;

    elsif r_co.code = 'jaarafsluiting' then
      v_sla_maanden := coalesce((r_co.parameters->>'sla_maanden')::int, 3);
      for v_year in
        extract(year from v_window_start)::int - 1 .. extract(year from v_window_end)::int + 1
      loop
        v_be := public.fiscal_year_end(r_co.boekjaar_einde_maand, r_co.boekjaar_einde_dag, v_year);
        v_bstart := (v_be - interval '1 year' + interval '1 day')::date;
        v_due_raw := (v_be + (v_sla_maanden || ' months')::interval)::date;
        continue when v_due_raw < v_window_start or v_due_raw > v_window_end;
        v_label := to_char(v_be, 'YYYY');
        v_new_id := public.upsert_generated_task(
          r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
          v_label, v_bstart, v_be, v_due_raw, v_default_employee, r_co.categorie
        );
      end loop;

    elsif r_co.code = 'algemene_vergadering' then
      for v_year in
        extract(year from v_window_start)::int - 1 .. extract(year from v_window_end)::int + 1
      loop
        v_be := public.fiscal_year_end(r_co.boekjaar_einde_maand, r_co.boekjaar_einde_dag, v_year);
        v_bstart := (v_be - interval '1 year' + interval '1 day')::date;
        v_due_raw := (v_be + interval '6 months')::date;
        continue when v_due_raw < v_window_start or v_due_raw > v_window_end;
        v_label := to_char(v_be, 'YYYY');

        v_av_id := public.upsert_generated_task(
          r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
          v_label, v_bstart, v_be, v_due_raw, v_default_employee, r_co.categorie
        );
        if v_av_id is null then
          select id into v_av_id from public.task_instances
          where client_id = r_co.client_id and obligation_type_id = r_co.obligation_type_id
            and periode_label = v_label and bron_type = 'automatisch_gegenereerd';
        end if;

        -- Companion neerlegging_jaarrekening instance (§2.5/§3.5):
        -- provisional due date now (AV due + 30d), recalculated for real
        -- once the AV task is actually completed (see 0004 trigger).
        if v_av_id is not null and v_ot_neerlegging is not null then
          perform public.upsert_generated_task(
            r_co.client_id, v_ot_neerlegging, null,
            v_label, v_be, v_be, (v_due_raw + 30), v_default_employee, 'wettelijk',
            true, v_av_id
          );
        end if;
      end loop;

    elsif r_co.code = 'aangifte_venb_pb' then
      v_scope := 'boekjaar_' || r_co.boekjaar_einde_maand;
      for v_year in
        extract(year from v_window_start)::int - 1 .. extract(year from v_window_end)::int + 1
      loop
        select deadline_datum into v_lc_date
        from public.legal_calendar
        where obligation_type_id = r_co.obligation_type_id
          and jaar = v_year
          and (scope = v_scope or scope is null)
        order by is_override desc, updated_at desc
        limit 1;

        -- No campaign date published yet for this year/scope -> skip.
        -- This is expected (§3.7: bewust handmatig onderhouden) and not
        -- an error; re-running generation later will pick it up.
        continue when v_lc_date is null;

        v_due_raw := v_lc_date;
        continue when v_due_raw < v_window_start or v_due_raw > v_window_end;
        v_be := public.fiscal_year_end(r_co.boekjaar_einde_maand, r_co.boekjaar_einde_dag, v_year);
        v_bstart := (v_be - interval '1 year' + interval '1 day')::date;
        v_label := to_char(v_be, 'YYYY');
        v_new_id := public.upsert_generated_task(
          r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
          v_label, v_bstart, v_be, v_due_raw, v_default_employee, r_co.categorie
        );
      end loop;

    elsif r_co.code = 'rapportering' then
      v_frequentie := coalesce(r_co.parameters->>'frequentie', 'kwartaal');
      v_termijn_dagen := coalesce((r_co.parameters->>'termijn_dagen')::int, 10);
      if v_frequentie = 'maand' then
        for v_period_start in
          select generate_series(date_trunc('month', v_gen_from), date_trunc('month', v_window_end), interval '1 month')::date
        loop
          v_period_eind := (v_period_start + interval '1 month' - interval '1 day')::date;
          v_due_raw := v_period_eind + v_termijn_dagen;
          continue when v_due_raw < v_window_start or v_due_raw > v_window_end;
          v_label := to_char(v_period_start, 'YYYY-MM');
          v_new_id := public.upsert_generated_task(
            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
            v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie
          );
        end loop;
      elsif v_frequentie = 'jaar' then
        for v_year in
          extract(year from v_gen_from)::int .. extract(year from v_window_end)::int
        loop
          v_period_start := make_date(v_year, 1, 1);
          v_period_eind := make_date(v_year, 12, 31);
          v_due_raw := v_period_eind + v_termijn_dagen;
          continue when v_due_raw < v_window_start or v_due_raw > v_window_end;
          v_label := v_year::text;
          v_new_id := public.upsert_generated_task(
            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
            v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie
          );
        end loop;
      else
        for v_period_start in
          select generate_series(date_trunc('quarter', v_gen_from), date_trunc('quarter', v_window_end), interval '3 months')::date
        loop
          v_period_eind := (v_period_start + interval '3 months' - interval '1 day')::date;
          v_due_raw := v_period_eind + v_termijn_dagen;
          continue when v_due_raw < v_window_start or v_due_raw > v_window_end;
          v_label := to_char(v_period_start, 'YYYY') || '-Q' || to_char(v_period_start, 'Q');
          v_new_id := public.upsert_generated_task(
            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
            v_label, v_period_start, v_period_eind, v_due_raw, v_default_employee, r_co.categorie
          );
        end loop;
      end if;

    elsif r_co.code = 'btw_klantenlisting' then
      if r_co.btw_regime <> 'geen' then
        for v_year in
          extract(year from v_gen_from)::int .. extract(year from v_window_end)::int
        loop
          v_due_raw := make_date(v_year + 1, 3, 31);
          continue when v_due_raw < v_window_start or v_due_raw > v_window_end;
          v_new_id := public.upsert_generated_task(
            r_co.client_id, r_co.obligation_type_id, r_co.client_obligation_id,
            v_year::text, make_date(v_year, 1, 1), make_date(v_year, 12, 31),
            v_due_raw, v_default_employee, r_co.categorie
          );
        end loop;
      end if;
    end if;
  end loop;

  select count(*) into v_after_count from public.task_instances where bron_type = 'automatisch_gegenereerd';
  return (v_after_count - v_before_count);
end;
$function$;

revoke execute on function public.generate_task_instances(int, int) from public, anon;

-- ============================================================
-- Herstel van de reeds gegenereerde rijen.
--
-- De functiewijziging hierboven repareert niets uit het verleden:
-- upsert_generated_task() doet `on conflict do nothing`, dus bestaande taken
-- houden hun oude datum. Elke al gegenereerde kwartaalaangifte staat dus nog
-- op de 20ste.
--
-- Alleen open, gegenereerde kwartaalaangiften worden bijgewerkt. Afgeronde of
-- geannuleerde taken blijven staan zoals ze waren — die zijn geschiedenis. De
-- update loopt door de pijplijnvlag van 0012, want due_date_wettelijk is
-- sinds 0013 bevroren voor alles buiten de kalenderpijplijn.
--
-- Een handmatig afgesproken deadline (due_date_handmatig_op) wordt niet
-- overschreven: daar verschuift alleen het wettelijke ijkpunt en gaat de taak
-- naar review, precies zoals de M-1-regel uit 0013/0014 voorschrijft.
-- ============================================================
do $$
declare
  r record;
  v_nieuw_wettelijk date;
  v_actor uuid;
  v_aantal int := 0;
begin
  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.due_date_handmatig_op,
           ti.review_vereist, ti.periode_eind, ti.toegewezen_medewerker_id
    from public.task_instances ti
    join public.obligation_types ot on ot.id = ti.obligation_type_id
    join public.clients c on c.id = ti.client_id
    where ot.code = 'btw_aangifte'
      and c.btw_aangifte_frequentie = 'kwartaal'
      and ti.bron_type = 'automatisch_gegenereerd'
      and ti.status = 'open'
      and ti.due_date_wettelijk
          = (date_trunc('month', ti.periode_eind) + interval '1 month')::date + 19
  loop
    v_nieuw_wettelijk := (date_trunc('month', r.periode_eind) + interval '1 month')::date + 24;
    v_actor := r.toegewezen_medewerker_id;

    perform set_config('taskflow.pipeline_task_id', r.id::text, true);

    if r.due_date_handmatig_op is not null then
      update public.task_instances
      set due_date_wettelijk = v_nieuw_wettelijk,
          review_vereist = true,
          review_reden = coalesce(review_reden || ' — ', '') ||
            'De wettelijke datum van de kwartaalaangifte is gecorrigeerd naar de 25ste; ' ||
            'deze taak heeft een handmatig afgesproken deadline. Controleer of die afspraak nog klopt.'
      where id = r.id;
    else
      update public.task_instances
      set due_date_wettelijk = v_nieuw_wettelijk,
          due_date = public.next_business_day(v_nieuw_wettelijk)
      where id = r.id;
    end if;

    insert into public.task_status_log (
      task_instance_id, event_type, oude_due_date, nieuwe_due_date,
      actor_employee_id, trigger_bron, notitie
    ) values (
      r.id, 'due_date_herberekend', r.due_date, public.next_business_day(v_nieuw_wettelijk),
      v_actor, 'kalender_herberekening',
      'Correctie: de btw-kwartaalaangifte valt op de 25ste, niet op de 20ste (migratie 0017).'
    );

    perform set_config('taskflow.pipeline_task_id', '', true);
    v_aantal := v_aantal + 1;
  end loop;

  raise notice 'Migratie 0017: % kwartaalaangiften gecorrigeerd naar de 25ste.', v_aantal;
end $$;
