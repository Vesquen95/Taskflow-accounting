-- Taskflow v1 -- de aangifte VenB/PB wordt berekend, niet opgezocht.
--
-- Aanleiding: het kantoor wees erop dat een dossier dat afsluit per 30 juni
-- zijn aangifte voor 31 januari moet indienen. De motor maakte daar niets
-- voor aan. Gemeten met twee klanten (31/12 en 30/06) en alle verplichtingen
-- aan:
--
--   AANGIFTE-TAKEN AANGEMAAKT: 0
--   RIJEN IN DE WETTELIJKE KALENDER VOOR DE AANGIFTE: 0
--
-- De deadline werd uitsluitend opgezocht in legal_calendar, per boekjaarcohort
-- ('boekjaar_6', 'boekjaar_12', ...). Stond die rij er niet, dan sloeg de
-- generatie de periode over: geen taak, geen foutmelding, geen lege regel. Een
-- wettelijke deadline die nergens in de applicatie bestond -- precies het
-- scenario waar het kantoor voor waarschuwde.
--
-- Fix: de motor rekent de standaarddatum zelf uit de laatste dag van de
-- zevende maand na het boekjaareinde. Bevestigd aan de hand van het voorbeeld
-- van het kantoor:
--
--   31/12/2026  ->  31/07/2027
--   30/06/2026  ->  31/01/2027   <- het voorbeeld
--   30/09/2026  ->  30/04/2027
--   31/03/2026  ->  31/10/2026
--
-- De wettelijke kalender behoudt zijn rol, maar de juiste: een OVERRIDE.
-- Kondigt de FOD een afwijkende campagnedatum aan, dan wint die van de
-- formule. Voorheen was het omgekeerd.
--
-- Additief: 0003-0018 zijn al toegepast en worden NIET gewijzigd. De functie
-- hieronder is de versie uit 0018, ongewijzigd op de aangiftetak na.

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
  v_ondergrens date;

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
      co.standaard_toegewezen_medewerker_id, co.geldig_vanaf,
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
    -- De ondergrens is de datum waarop deze verplichting begon te lopen, niet
    -- het globale terugkijkvenster.
    v_ondergrens := greatest(v_window_start, r_co.geldig_vanaf);

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
            continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
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
            v_due_raw := (date_trunc('month', v_period_eind) + interval '1 month')::date + 24;
            continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
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
          -- Terugrekenen vanaf de maand van het boekjaareinde.
          v_month_offset := case v_i when 1 then -8 when 2 then -5 when 3 then -2 else 0 end;
          v_day := case v_i when 4 then 20 else 10 end;
          v_due_raw := (date_trunc('month', v_be) + (v_month_offset || ' months')::interval)::date + (v_day - 1);
          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
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
        continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
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
        continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
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
        v_be := public.fiscal_year_end(r_co.boekjaar_einde_maand, r_co.boekjaar_einde_dag, v_year);

        -- Standaard: de laatste dag van de zevende maand na het boekjaareinde.
        -- 31/12 -> 31/07, 30/06 -> 31/01, 30/09 -> 30/04, 31/03 -> 31/10.
        v_due_raw := (date_trunc('month', v_be) + interval '8 months' - interval '1 day')::date;

        -- De wettelijke kalender is hier een OVERRIDE, geen voorwaarde. Vroeger
        -- werd de datum uitsluitend daar opgezocht en werd de periode
        -- overgeslagen als er geen rij stond: geen taak, geen melding, een
        -- deadline die nergens bestond. Nu rekent de motor zelf en wint een
        -- ingevulde campagnedatum.
        select deadline_datum into v_lc_date
        from public.legal_calendar
        where obligation_type_id = r_co.obligation_type_id
          and jaar = v_year
          and (scope = v_scope or scope is null)
        order by is_override desc, updated_at desc
        limit 1;
        if v_lc_date is not null then
          v_due_raw := v_lc_date;
        end if;

        continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
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
          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
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
          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
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
          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
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
          continue when v_due_raw < v_ondergrens or v_due_raw > v_window_end;
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
-- De kalender-override moet ook bestaande taken verzetten.
--
-- Gereproduceerd: een 31/12-klant met de berekende standaarddatum 31/07/2027,
-- daarna een override op 30/09/2027 ingevoerd -> de taak bleef op 31/07.
-- upsert_generated_task() doet `on conflict do nothing`, dus hergeneratie
-- raakt bestaande rijen niet; het verzetten hoort van deze trigger te komen.
-- Die matchte `scope` echter als tekstfragment van het periodelabel, wat voor
-- een boekjaarcohort ('boekjaar_12' tegen label '2026') nooit klopt. Zonder
-- deze fix is "de wettelijke kalender is een override" alleen waar voor taken
-- die nog gegenereerd moeten worden.
-- ============================================================
CREATE OR REPLACE FUNCTION public.recalc_due_dates_on_legal_calendar_override()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  v_new_due date;
  v_firm uuid;
begin
  if not new.is_override then
    return new;
  end if;

  select firm_id into v_firm from public.employees where id = new.gewijzigd_door;

  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk, ti.due_date_handmatig_op,
           ti.review_vereist, ti.review_reden
    from public.task_instances ti
    join public.clients c on c.id = ti.client_id
    where ti.obligation_type_id = new.obligation_type_id
      and ti.status = 'open'
      and (
        extract(year from ti.periode_eind) = new.jaar
        or extract(year from ti.due_date_wettelijk) = new.jaar
      )
      and (
        new.scope is null
        -- 'boekjaar_<maand>' duidt een cohort klanten aan op hun
        -- boekjaareinde, geen fragment van het periodelabel. Als tekstmatch
        -- ('2026' ilike '%boekjaar_12%') was dit nooit waar, waardoor een
        -- aangekondigde campagnedatum bestaande taken nooit verzette.
        or (new.scope ~ '^boekjaar_[0-9]+$'
            and c.boekjaar_einde_maand = substring(new.scope from 10)::int)
        or (new.scope !~ '^boekjaar_[0-9]+$'
            and ti.periode_label ilike '%' || new.scope || '%')
      )
      and (v_firm is null or c.firm_id = v_firm)
  loop
    v_new_due := public.next_business_day(new.deadline_datum);
    if v_new_due is distinct from r.due_date or new.deadline_datum is distinct from r.due_date_wettelijk then
      perform set_config('taskflow.pipeline_task_id', r.id::text, true);

      if r.due_date_handmatig_op is not null then
        -- Het wettelijke ijkpunt volgt de kalender, de afgesproken werkdatum
        -- blijft staan — met een signaal (M-1).
        update public.task_instances
        set due_date_wettelijk = new.deadline_datum,
            review_vereist = true,
            review_reden = coalesce(r.review_reden || ' — ', '') ||
              'De wettelijke campagnedatum werd gecorrigeerd naar ' ||
              to_char(new.deadline_datum, 'DD/MM/YYYY') ||
              ', maar deze taak heeft een handmatig afgesproken deadline. Controleer of die afspraak nog klopt.'
        where id = r.id;

        insert into public.task_status_log (
          task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
        ) values (
          r.id, 'due_date_herberekend', r.due_date_wettelijk, new.deadline_datum,
          new.gewijzigd_door, 'kalender_herberekening',
          'Wettelijke datum gecorrigeerd; de handmatig afgesproken deadline is behouden en gemarkeerd voor review.'
        );
      else
        update public.task_instances
        set due_date_wettelijk = new.deadline_datum, due_date = v_new_due
        where id = r.id;

        insert into public.task_status_log (
          task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
        ) values (
          r.id, 'due_date_herberekend', r.due_date_wettelijk, new.deadline_datum,
          new.gewijzigd_door, 'kalender_herberekening',
          'Herberekend n.a.v. correctie in de wettelijke kalender'
        );
      end if;

      perform set_config('taskflow.pipeline_task_id', '', true);
    end if;
  end loop;

  return new;
end;
$function$;

revoke execute on function public.recalc_due_dates_on_legal_calendar_override() from public, anon, authenticated;
