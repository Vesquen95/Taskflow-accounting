-- Taskflow v1 — security hardening (fixes from the security/tester review
-- of migrations 0003-0007). 0003-0007 are already applied in production and
-- are left untouched; every fix here is a fresh CREATE OR REPLACE / new
-- object so it can be applied as a follow-up migration.
--
-- Covers:
--   1. (Critical) `actief` was not checked in current_employee_id()/
--      current_employee_firm_id()/can_view_client() — a deactivated
--      employee kept full RLS access for the lifetime of their Supabase
--      session.
--   2. (Critical) generate_task_instances() was not firm-scoped — any
--      kantoorbeheerder could generate task instances for every firm on
--      the instance, not just their own.
--   3. (Critical) claim_invite()/create_firm_and_admin() trusted
--      auth.users.email without checking it was actually verified —
--      a plausible email-spoofing path to claim someone else's invite
--      when "Confirm email" is off.
--   4. (High) any employee could declassify a client (toggle
--      `vertrouwelijk`) or change `standaard_verantwoordelijke_id`,
--      un-gated and unlogged.
--   5. (High) claim_invite()'s UPDATE had no disambiguation when the same
--      email had pending invites in more than one firm (cross-firm invite
--      squatting via invite_employee(), which only checks uniqueness
--      within its own firm) — this could crash on the `unique
--      (auth_user_id)` constraint instead of failing cleanly.
--   6. (Medium) legal_calendar/public_holidays being shared across firms
--      is a deliberate design choice (docs/PLAN.md §2.9/§2.10) — documented
--      here as an accepted residual risk, no code change.

-- ============================================================
-- 1. actief-check in identity helpers + can_view_client()
-- ============================================================
create or replace function public.current_employee_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select id from public.employees where auth_user_id = auth.uid() and actief limit 1;
$$;

create or replace function public.current_employee_firm_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select firm_id from public.employees where auth_user_id = auth.uid() and actief limit 1;
$$;

-- can_view_client(): same predicate as docs/PLAN.md §2.11, plus an
-- explicit `e.actief` guard so a deactivated employee is never treated as
-- able to view a confidential client (even if called directly with their
-- employee id, e.g. from a stale current_employee_id() cached client-side).
create or replace function public.can_view_client(p_client_id uuid, p_employee_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    e.actief
    and (
      not c.vertrouwelijk
      or e.rol = 'kantoorbeheerder'
      or exists (
        select 1 from task_instances ti
        where ti.client_id = p_client_id
          and ti.toegewezen_medewerker_id = p_employee_id
          and ti.status <> 'geannuleerd'
      )
    )
  from clients c, employees e
  where c.id = p_client_id and e.id = p_employee_id;
$$;

-- ============================================================
-- UI guard companion (App.tsx/useCurrentEmployee, see src/): with actief
-- now checked inside current_employee_firm_id(), a deactivated employee's
-- own `employees` row would otherwise become invisible to them too (the
-- existing 0005 "employees_select" policy is firm-scoped via that same
-- function) — which would make the UI show "onboarding not started"
-- instead of a clear "your account is deactivated" message. Add an
-- explicit, narrow "always see your own row" policy so the client can
-- still fetch enough to detect actief=false and show the right screen +
-- force a sign-out. This does not widen access to anyone else's data —
-- it only ever matches the row where auth_user_id = auth.uid().
-- ============================================================
drop policy if exists "employees_select_own" on public.employees;
create policy "employees_select_own" on public.employees
  for select using (auth_user_id = auth.uid());

-- ============================================================
-- 2. generate_task_instances(): firm-scope the main loop so a
--    kantoorbeheerder can only generate instances for their own firm.
-- ============================================================
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

-- ============================================================
-- 3. Require a verified email before create_firm_and_admin()/claim_invite()
--    trust auth.users.email as this user's identity. Without this, on an
--    instance with "Confirm email" disabled, anyone could sign up with an
--    unverified email matching a colleague's pending invite and claim it.
-- ============================================================
create or replace function public.create_firm_and_admin(p_firm_naam text, p_medewerker_naam text)
returns table(employee_id uuid, firm_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_email_confirmed_at timestamptz;
  v_firm_id uuid;
  v_employee_id uuid;
begin
  if v_uid is null then
    raise exception 'Niet ingelogd';
  end if;
  if exists (select 1 from public.employees where auth_user_id = v_uid) then
    raise exception 'Deze gebruiker is al gekoppeld aan een medewerkersprofiel';
  end if;
  if p_firm_naam is null or char_length(trim(p_firm_naam)) = 0 then
    raise exception 'Kantoornaam is verplicht';
  end if;
  if p_medewerker_naam is null or char_length(trim(p_medewerker_naam)) = 0 then
    raise exception 'Je naam is verplicht';
  end if;

  select email, email_confirmed_at into v_email, v_email_confirmed_at from auth.users where id = v_uid;
  if v_email is null then
    raise exception 'Kon geen e-mailadres vinden voor deze gebruiker';
  end if;
  if v_email_confirmed_at is null then
    raise exception 'Bevestig eerst je e-mailadres via de link in de bevestigingsmail voor je een kantoor aanmaakt.';
  end if;

  if exists (select 1 from public.employees where lower(email) = lower(v_email) and auth_user_id is null) then
    raise exception 'Er staat al een uitnodiging klaar voor dit e-mailadres. Gebruik "Ik heb een uitnodiging" in plaats van een nieuw kantoor aan te maken.';
  end if;

  insert into public.firms (naam) values (trim(p_firm_naam)) returning id into v_firm_id;

  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
  values (v_firm_id, v_uid, trim(p_medewerker_naam), v_email, 'kantoorbeheerder', true, true)
  returning id into v_employee_id;

  if not exists (select 1 from public.public_holidays limit 1) then
    perform public.seed_default_public_holidays(v_employee_id);
  end if;

  perform public.seed_demo_data_for_firm(v_firm_id, v_employee_id);

  return query select v_employee_id, v_firm_id;
end;
$$;

-- ============================================================
-- 5. claim_invite(): verified-email guard (point 3 above) + disambiguation
--    when the same email has pending invites in more than one firm (point
--    5) — invite_employee() only enforces email uniqueness within its own
--    firm (docs/PLAN.md invite-by-email design), so it's possible for two
--    different firms to both pre-create a pending employees row for the
--    same email before that person ever signs up. Previously the blind
--    UPDATE could then hit `unique (auth_user_id)` and crash with a raw
--    constraint-violation error; now we count matches up front and fail
--    with a clear, actionable message instead. Full token-based invites
--    (rather than email-matching) would remove the ambiguity entirely but
--    is a larger rework — left for a later iteration, see summary.
-- ============================================================
create or replace function public.claim_invite()
returns table(employee_id uuid, firm_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_email_confirmed_at timestamptz;
  v_id uuid;
  v_firm uuid;
  v_match_count int;
begin
  if v_uid is null then
    raise exception 'Niet ingelogd';
  end if;
  if exists (select 1 from public.employees where auth_user_id = v_uid) then
    raise exception 'Deze gebruiker is al gekoppeld aan een medewerkersprofiel';
  end if;

  select email, email_confirmed_at into v_email, v_email_confirmed_at from auth.users where id = v_uid;
  if v_email is null then
    raise exception 'Kon geen e-mailadres vinden voor deze gebruiker';
  end if;
  if v_email_confirmed_at is null then
    raise exception 'Bevestig eerst je e-mailadres via de link in de bevestigingsmail voor je een uitnodiging claimt.';
  end if;

  select count(*) into v_match_count
  from public.employees e
  where lower(e.email) = lower(v_email) and e.auth_user_id is null;

  if v_match_count = 0 then
    raise exception 'Geen openstaande uitnodiging gevonden voor dit e-mailadres';
  end if;
  if v_match_count > 1 then
    raise exception 'Er staan meerdere openstaande uitnodigingen klaar voor dit e-mailadres in verschillende kantoren. Neem contact op met je kantoorbeheerder om dit manueel te laten oplossen.';
  end if;

  update public.employees e
  set auth_user_id = v_uid
  where lower(e.email) = lower(v_email) and e.auth_user_id is null
  returning e.id, e.firm_id into v_id, v_firm;

  return query select v_id, v_firm;
end;
$$;

-- ============================================================
-- 4. clients: block un-audited changes to `vertrouwelijk` /
--    `standaard_verantwoordelijke_id` by anyone other than a
--    kantoorbeheerder, and log every such change. Pattern mirrors
--    block_offboarding_with_open_tasks() (0004).
-- ============================================================
create table if not exists public.client_change_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  veld text not null check (veld in ('vertrouwelijk', 'standaard_verantwoordelijke_id')),
  oude_waarde text,
  nieuwe_waarde text,
  actor_employee_id uuid not null references public.employees(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_client_change_log_client_id on public.client_change_log(client_id, created_at);

alter table public.client_change_log enable row level security;

-- Read-only for the app (writes are trigger-only, same pattern as
-- task_status_log in 0005) — scoped through the same can_access_client()
-- confidentiality gate as the client itself.
drop policy if exists "client_change_log_select" on public.client_change_log;
create policy "client_change_log_select" on public.client_change_log
  for select using (public.can_access_client(client_id));

create or replace function public.block_unaudited_confidentiality_change()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid;
begin
  if new.vertrouwelijk is distinct from old.vertrouwelijk
     or new.standaard_verantwoordelijke_id is distinct from old.standaard_verantwoordelijke_id then

    if not public.is_kantoorbeheerder() then
      raise exception
        'Enkel een kantoorbeheerder kan de vertrouwelijkheid of de standaard verantwoordelijke van een klant wijzigen.'
        using errcode = 'insufficient_privilege';
    end if;

    v_actor := public.current_employee_id();
    if v_actor is null then
      raise exception 'Wijziging vereist een ingelogde, gekoppelde medewerker';
    end if;

    if new.vertrouwelijk is distinct from old.vertrouwelijk then
      insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
      values (new.id, 'vertrouwelijk', old.vertrouwelijk::text, new.vertrouwelijk::text, v_actor);
    end if;

    if new.standaard_verantwoordelijke_id is distinct from old.standaard_verantwoordelijke_id then
      insert into public.client_change_log (client_id, veld, oude_waarde, nieuwe_waarde, actor_employee_id)
      values (new.id, 'standaard_verantwoordelijke_id', old.standaard_verantwoordelijke_id::text, new.standaard_verantwoordelijke_id::text, v_actor);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_clients_block_unaudited_confidentiality_change on public.clients;
create trigger trg_clients_block_unaudited_confidentiality_change
  before update of vertrouwelijk, standaard_verantwoordelijke_id on public.clients
  for each row
  execute function public.block_unaudited_confidentiality_change();

revoke execute on function public.block_unaudited_confidentiality_change() from public, anon, authenticated;

-- ============================================================
-- 6. legal_calendar/public_holidays are deliberately shared/global across
--    firms (docs/PLAN.md §2.9/§2.10) — every firm on this instance follows
--    the same Belgian statutory deadlines and public holidays, so one
--    kantoorbeheerder correcting/extending the calendar affects every
--    other firm's generated task_instances too. This is an accepted
--    residual risk of the shared-reference-data design, not a bug: see
--    docs/PLAN.md for the explicit note.
-- ============================================================
comment on table public.legal_calendar is
  'Global/shared across all firms on this instance by design (docs/PLAN.md §2.9). '
  'A correction made by one firm''s kantoorbeheerder affects every firm''s generated '
  'task_instances. Accepted residual risk, not a bug — see PLAN.md.';

comment on table public.public_holidays is
  'Global/shared across all firms on this instance by design (docs/PLAN.md §2.10). '
  'Same accepted residual risk as legal_calendar — see PLAN.md.';
