-- Taskflow v1 — recurrence engine (docs/PLAN.md §3.1/§3.2).
--
-- Mechanism choice (documented per "Belangrijk voor de developer-agent"):
-- there is no cron infrastructure in this repo/project yet, and this build
-- has no access to provision one (Edge Functions + pg_cron need to be set
-- up outside what a migration file can do). So v1 ships the pragmatic
-- fallback the plan explicitly allows: generation lives entirely in this
-- SQL function (`generate_task_instances`), callable on demand via
-- `supabase.rpc('generate_task_instances')`. The frontend exposes this as
-- an explicit "Genereer taken nu" action on the Wettelijke-kalenderbeheer
-- screen, restricted to kantoorbeheerder. A follow-up iteration can wrap
-- this same function in a scheduled Edge Function / pg_cron job without
-- changing its logic at all — the rolling-horizon + idempotent-upsert
-- design already supports being called repeatedly/on a schedule.
--
-- All generated due dates go through the same pipeline (§3.1): compute a
-- raw date -> next_business_day() -> store as due_date_wettelijk (raw) +
-- due_date (shifted). due_date_verschoven is a generated column (0003).

create or replace function public.fiscal_year_end(p_maand int, p_dag int, p_year int)
returns date
language sql immutable
as $$
  select least(
    (make_date(p_year, p_maand, 1) + interval '1 month' - interval '1 day')::date,
    (make_date(p_year, p_maand, 1) + ((p_dag - 1) || ' days')::interval)::date
  );
$$;

-- Idempotent insert of one generated task instance. Returns the row's id
-- when a new row was actually created, or NULL when it already existed
-- (on conflict do nothing) — callers use this to count real creations.
create or replace function public.upsert_generated_task(
  p_client_id uuid,
  p_obligation_type_id uuid,
  p_client_obligation_id uuid,
  p_periode_label text,
  p_periode_start date,
  p_periode_eind date,
  p_due_raw date,
  p_toegewezen uuid,
  p_categorie public.obligation_categorie,
  p_voorlopige_datum boolean default false,
  p_voorloper_taak_id uuid default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_due date := public.next_business_day(p_due_raw);
  v_id uuid;
begin
  insert into public.task_instances (
    client_id, obligation_type_id, client_obligation_id, periode_label,
    periode_start, periode_eind, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, voorloper_taak_id, bron_type,
    voorlopige_datum, vereist_goedkeuring
  ) values (
    p_client_id, p_obligation_type_id, p_client_obligation_id, p_periode_label,
    p_periode_start, p_periode_eind, v_due, p_due_raw,
    'open', p_toegewezen, p_voorloper_taak_id, 'automatisch_gegenereerd',
    p_voorlopige_datum, (p_categorie = 'wettelijk')
  )
  on conflict (client_id, obligation_type_id, periode_label)
    where bron_type = 'automatisch_gegenereerd'
  do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- Main entry point. Generates task_instances for every active
-- client_obligation whose computed due date falls inside a rolling
-- window: [today - p_backfill_months, today + p_horizon_months]. The
-- backfill window exists so that a firm's *first* run of this function
-- (right after onboarding, or after a period with no admin login) still
-- produces the currently-relevant instances, not just brand-new future
-- ones. Safe to call repeatedly (idempotent via upsert_generated_task).
create or replace function public.generate_task_instances(
  p_horizon_months int default 3,
  p_backfill_months int default 6
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
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
  if v_actor is null or not public.is_kantoorbeheerder() then
    raise exception 'Alleen een kantoorbeheerder kan taakgeneratie starten';
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
            v_due_raw := (date_trunc('month', v_period_eind) + interval '1 month')::date + 19;
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
          v_month_offset := case v_i when 1 then 4 when 2 then 7 when 3 then 10 else 12 end;
          v_day := case v_i when 4 then 20 else 10 end;
          v_due_raw := (date_trunc('month', v_bstart) + ((v_month_offset - 1) || ' months')::interval)::date + (v_day - 1);
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
$$;

grant execute on function public.generate_task_instances(int, int) to authenticated;
