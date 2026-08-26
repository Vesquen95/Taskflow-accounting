-- Taskflow v1 — recurrence-engine regression tests (docs/PLAN.md §3).
--
-- Run via ./run_recurrence_tests.sh (see README note at the bottom of this
-- file, and the developer-agent summary). This script assumes it is being
-- run against a fresh database that already has 0001-0012 applied plus the
-- local auth stub (00_local_auth_stub.sql) — the runner script takes care
-- of both. It is NOT vitest/pgTAP; it is a plain, repeatable psql script
-- that raises an exception (non-zero exit via ON_ERROR_STOP) on the first
-- failing assertion and prints a NOTICE per passing one, ending with a
-- clear "ALL RECURRENCE ENGINE TESTS PASSED" banner.
--
-- Covers (per the tester's finding): next_business_day() on weekend/
-- holiday/normal day; fiscal_year_end() with a non-calendar-year boekjaar
-- and a day that does not exist in every month; generate_task_instances()
-- idempotency (two calls -> no duplicates, no new rows on the second call)
-- and no gaps/duplicates at period boundaries; firm-scoping of
-- generate_task_instances() (regression test for the 0008 security fix);
-- and the AV -> neerlegging recalculation end-to-end.
--
-- Secties 6-14 dekken de security-review van 2026-08-25 (migraties 0009-0011),
-- secties 15-19 de tweede review daarna (migratie 0012): kaping van de
-- AV-pijplijn via voorloper_taak_id, INSERT-hardening van de
-- goedkeuringsstap, het correctiepad rond annuleren/hergenereren, de extra
-- bevroren kolommen en de begrensde feestdag-herberekening.

\set ON_ERROR_STOP on

-- ============================================================
-- Test helper
-- ============================================================
create or replace function pg_temp.test_assert(p_cond boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_cond, false) then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'PASS: %', p_label;
end;
$$;

-- ============================================================
-- Fixtures: one firm + one active kantoorbeheerder to act as, plus a
-- second firm (for the firm-scoping regression test).
-- ============================================================
do $$
declare
  v_admin_uid uuid;
  v_firm1 uuid;
  v_admin_emp uuid;
  v_firm2 uuid;
  v_firm2_admin_uid uuid;
  v_firm2_admin_emp uuid;
begin
  insert into auth.users (email, email_confirmed_at) values ('admin@test.local', now()) returning id into v_admin_uid;
  insert into public.firms (naam) values ('Test Kantoor 1') returning id into v_firm1;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm1, v_admin_uid, 'Test Admin', 'admin@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin_emp;

  insert into auth.users (email, email_confirmed_at) values ('admin2@test.local', now()) returning id into v_firm2_admin_uid;
  insert into public.firms (naam) values ('Test Kantoor 2 (firm-scoping control)') returning id into v_firm2;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm2, v_firm2_admin_uid, 'Andere Kantoorbeheerder', 'admin2@test.local', 'kantoorbeheerder', true, true)
    returning id into v_firm2_admin_emp;

  -- Stash ids for later blocks via a temp table (simplest way to share
  -- state across separate `do` blocks in a plain psql script).
  create temporary table test_fixture_ids (key text primary key, value uuid);
  insert into test_fixture_ids values
    ('admin_uid', v_admin_uid), ('firm1', v_firm1), ('admin_emp', v_admin_emp),
    ('firm2', v_firm2), ('firm2_admin_emp', v_firm2_admin_emp);

  -- Act as firm 1's kantoorbeheerder for the rest of the script.
  perform set_config('taskflow.test_uid', v_admin_uid::text, false);
end $$;

-- ============================================================
-- 1. next_business_day() — weekend / holiday / normal weekday.
-- Anchored on ISO week-of-date math (date_trunc('week', ...) returns the
-- Monday of that week), never a hardcoded "this date happens to be a
-- Saturday" assumption.
-- ============================================================
do $$
declare
  v_admin_emp uuid := (select value from test_fixture_ids where key = 'admin_emp');
  v_monday date := date_trunc('week', date '2030-03-04')::date;
  v_tuesday date := v_monday + 1;   -- plain weekday, no holiday -> no-op
  v_wednesday date := v_monday + 2; -- will become a holiday
  v_saturday date := v_monday + 5;  -- weekend
begin
  perform pg_temp.test_assert(extract(isodow from v_tuesday) = 2, 'fixture sanity: v_tuesday is really a Tuesday');
  perform pg_temp.test_assert(extract(isodow from v_saturday) = 6, 'fixture sanity: v_saturday is really a Saturday');

  perform pg_temp.test_assert(
    public.next_business_day(v_tuesday) = v_tuesday,
    'next_business_day: a plain weekday with no holiday is left unchanged'
  );

  perform pg_temp.test_assert(
    public.next_business_day(v_saturday) = v_monday + 7,
    'next_business_day: a Saturday rolls forward to the following Monday'
  );

  insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
  values (2030, v_wednesday, 'Test-feestdag', v_admin_emp, v_admin_emp);

  perform pg_temp.test_assert(
    public.next_business_day(v_wednesday) = v_wednesday + 1,
    'next_business_day: a public holiday on a weekday rolls forward to the next business day'
  );
end $$;

-- ============================================================
-- 2. fiscal_year_end() — non-calendar-year boekjaar + a day that does not
-- exist in every month (Feb 30 in a leap and a non-leap year; April 31).
-- ============================================================
do $$
begin
  perform pg_temp.test_assert(
    public.fiscal_year_end(12, 31, 2026) = date '2026-12-31',
    'fiscal_year_end: calendar-year boekjaar (12/31) resolves as-is'
  );

  perform pg_temp.test_assert(
    public.fiscal_year_end(6, 30, 2026) = date '2026-06-30',
    'fiscal_year_end: non-calendar-year boekjaar (30/06) resolves as-is'
  );

  perform pg_temp.test_assert(
    public.fiscal_year_end(2, 30, 2026) = date '2026-02-28',
    'fiscal_year_end: day 30 clamps to Feb 28 in a non-leap year (2026)'
  );

  perform pg_temp.test_assert(
    public.fiscal_year_end(2, 30, 2028) = date '2028-02-29',
    'fiscal_year_end: day 30 clamps to Feb 29 in a leap year (2028)'
  );

  perform pg_temp.test_assert(
    public.fiscal_year_end(4, 31, 2026) = date '2026-04-30',
    'fiscal_year_end: day 31 clamps to April 30 (April never has 31 days)'
  );
end $$;

-- ============================================================
-- 3. generate_task_instances(): fixtures — a monthly-BTW client (firm 1,
-- for idempotency + period-boundary checks), an AV client (firm 1, for the
-- AV -> neerlegging test), and a monthly-BTW client on a *different* firm
-- (firm 2, to prove the 0008 firm-scoping fix holds).
-- ============================================================
do $$
declare
  v_firm1 uuid := (select value from test_fixture_ids where key = 'firm1');
  v_admin_emp uuid := (select value from test_fixture_ids where key = 'admin_emp');
  v_firm2 uuid := (select value from test_fixture_ids where key = 'firm2');
  v_firm2_admin_emp uuid := (select value from test_fixture_ids where key = 'firm2_admin_emp');
  v_client_a uuid;
  v_client_b uuid;
  v_client_c uuid;
  v_ot_av uuid;
begin
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';

  -- Client A (firm 1): monthly BTW-aangever -> trg_clients_sync_btw_obligations
  -- auto-creates the btw_aangifte (monthly) + btw_klantenlisting client_obligations.
  insert into public.clients (
    firm_id, naam, ondernemingsnummer, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, btw_aangifte_frequentie, vertrouwelijk, actief
  ) values (
    v_firm1, 'Test Klant A (maandaangever)', 'BE0000.900.001', 12, 31,
    'periodieke_aangever', 'maand', false, true
  ) returning id into v_client_a;

  -- Client B (firm 1): algemene_vergadering, for the AV -> neerlegging test.
  insert into public.clients (
    firm_id, naam, ondernemingsnummer, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, vertrouwelijk, actief
  ) values (
    v_firm1, 'Test Klant B (AV)', 'BE0000.900.002', 12, 31, 'geen', false, true
  ) returning id into v_client_b;

  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
  values (v_client_b, v_ot_av, true, date '2000-01-01', v_admin_emp);

  -- Client C (firm 2): same monthly-BTW shape as client A, used only to
  -- prove firm-scoping — generate_task_instances() is called as firm 1's
  -- kantoorbeheerder, so nothing should ever be generated for this client.
  insert into public.clients (
    firm_id, naam, ondernemingsnummer, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, btw_aangifte_frequentie, vertrouwelijk, actief
  ) values (
    v_firm2, 'Test Klant C (andere firm)', 'BE0000.900.003', 12, 31,
    'periodieke_aangever', 'maand', false, true
  ) returning id into v_client_c;

  create temporary table test_fixture_ids2 (key text primary key, value uuid);
  insert into test_fixture_ids2 values ('client_a', v_client_a), ('client_b', v_client_b), ('client_c', v_client_c);
end $$;

-- ============================================================
-- 4. Idempotency + no gaps/duplicates at period boundaries + firm-scoping.
-- ============================================================
do $$
declare
  v_client_a uuid := (select value from test_fixture_ids2 where key = 'client_a');
  v_client_c uuid := (select value from test_fixture_ids2 where key = 'client_c');
  v_created_first int;
  v_created_second int;
  v_total_after_first bigint;
  v_total_after_second bigint;
  v_gap_count int;
  v_dup_label_count int;
  v_firm2_leak_count int;
begin
  v_created_first := public.generate_task_instances(3, 6);
  perform pg_temp.test_assert(v_created_first > 0, 'generate_task_instances: first run creates at least one instance');

  select count(*) into v_total_after_first from public.task_instances where bron_type = 'automatisch_gegenereerd';

  v_created_second := public.generate_task_instances(3, 6);
  select count(*) into v_total_after_second from public.task_instances where bron_type = 'automatisch_gegenereerd';

  perform pg_temp.test_assert(
    v_created_second = 0,
    format('generate_task_instances: second run reports 0 newly-created rows (got %s)', v_created_second)
  );
  perform pg_temp.test_assert(
    v_total_after_second = v_total_after_first,
    format('generate_task_instances: idempotent — total row count unchanged across two runs (%s vs %s)', v_total_after_first, v_total_after_second)
  );

  -- No duplicate (client_id, obligation_type_id, periode_label) among
  -- generated rows for client A (also enforced structurally by the unique
  -- index in 0003, but asserted here as a behavioural check too).
  select count(*) into v_dup_label_count from (
    select client_id, obligation_type_id, periode_label, count(*) as c
    from public.task_instances
    where bron_type = 'automatisch_gegenereerd' and client_id = v_client_a
    group by client_id, obligation_type_id, periode_label
    having count(*) > 1
  ) dups;
  perform pg_temp.test_assert(v_dup_label_count = 0, 'generate_task_instances: no duplicate periode_label rows for client A');

  -- No gaps/overlaps between consecutive monthly btw_aangifte periods for
  -- client A: each period's start must be exactly the previous period's
  -- end + 1 day.
  select count(*) into v_gap_count from (
    select
      periode_start,
      periode_eind,
      lag(periode_eind) over (order by periode_start) as prev_eind
    from public.task_instances ti
    join public.obligation_types ot on ot.id = ti.obligation_type_id
    where ti.client_id = v_client_a and ot.code = 'btw_aangifte' and ti.bron_type = 'automatisch_gegenereerd'
  ) periods
  where prev_eind is not null and periode_start <> prev_eind + 1;
  perform pg_temp.test_assert(v_gap_count = 0, 'generate_task_instances: no gaps/overlaps between consecutive monthly btw_aangifte periods');

  -- Firm-scoping regression test (0008 fix #2): calling
  -- generate_task_instances() as firm 1's kantoorbeheerder must never
  -- generate instances for firm 2's client, even though it has an
  -- identically-shaped active client_obligation and its own kantoorbeheerder.
  select count(*) into v_firm2_leak_count
  from public.task_instances
  where client_id = v_client_c and bron_type = 'automatisch_gegenereerd';
  perform pg_temp.test_assert(v_firm2_leak_count = 0, 'generate_task_instances: firm-scoped — does not generate instances for another firm''s client');
end $$;

-- ============================================================
-- 5. AV -> neerlegging recalculation, end-to-end (§3 point 5).
-- ============================================================
do $$
declare
  v_client_b uuid := (select value from test_fixture_ids2 where key = 'client_b');
  v_ot_av uuid;
  v_av_id uuid;
  v_neerlegging_id uuid;
  v_av_due_wettelijk date;
  v_pre_due_wettelijk date;
  v_pre_due date;
  v_pre_voorlopig boolean;
  v_post_afgerond_op timestamptz;
  v_post_due_wettelijk date;
  v_post_due date;
  v_post_voorlopig boolean;
  v_log_count int;
begin
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';

  select ti.id, ti.due_date_wettelijk into v_av_id, v_av_due_wettelijk
  from public.task_instances ti
  where ti.client_id = v_client_b and ti.obligation_type_id = v_ot_av and ti.bron_type = 'automatisch_gegenereerd'
  order by ti.due_date asc
  limit 1;

  perform pg_temp.test_assert(v_av_id is not null, 'AV fixture: an algemene_vergadering instance was generated for client B');

  select ti.due_date_wettelijk, ti.due_date, ti.voorlopige_datum
  into v_pre_due_wettelijk, v_pre_due, v_pre_voorlopig
  from public.task_instances ti
  where ti.voorloper_taak_id = v_av_id;

  perform pg_temp.test_assert(v_pre_voorlopig = true, 'AV -> neerlegging: companion instance starts with voorlopige_datum = true');
  perform pg_temp.test_assert(
    v_pre_due_wettelijk = v_av_due_wettelijk + 30,
    'AV -> neerlegging: provisional due_date_wettelijk = AV due_date_wettelijk + 30 days'
  );
  perform pg_temp.test_assert(
    v_pre_due = public.next_business_day(v_pre_due_wettelijk),
    'AV -> neerlegging: provisional due_date has already gone through next_business_day()'
  );

  -- Walk the AV task through its real statusflow (open -> in_uitvoering ->
  -- wacht_op_goedkeuring -> ingediend_afgerond) rather than jumping status
  -- directly, so the test also exercises the enforcement trigger.
  update public.task_instances set status = 'in_uitvoering' where id = v_av_id;
  update public.task_instances set status = 'wacht_op_goedkeuring' where id = v_av_id;
  update public.task_instances set status = 'ingediend_afgerond' where id = v_av_id;

  select id into v_neerlegging_id from public.task_instances where voorloper_taak_id = v_av_id;

  select afgerond_op into v_post_afgerond_op from public.task_instances where id = v_av_id;
  perform pg_temp.test_assert(v_post_afgerond_op is not null, 'AV completion: afgerond_op is set once the AV task reaches ingediend_afgerond');

  select due_date_wettelijk, due_date, voorlopige_datum
  into v_post_due_wettelijk, v_post_due, v_post_voorlopig
  from public.task_instances where id = v_neerlegging_id;

  perform pg_temp.test_assert(v_post_voorlopig = false, 'AV -> neerlegging: voorlopige_datum flips to false once the AV is actually completed');
  perform pg_temp.test_assert(
    v_post_due_wettelijk = v_post_afgerond_op::date + 30,
    'AV -> neerlegging: due_date_wettelijk is recalculated from the AV''s real completion date (+30 days)'
  );
  perform pg_temp.test_assert(
    v_post_due = public.next_business_day(v_post_due_wettelijk),
    'AV -> neerlegging: recalculated due_date has gone through next_business_day() too'
  );

  select count(*) into v_log_count
  from public.task_status_log
  where task_instance_id = v_neerlegging_id
    and event_type = 'due_date_herberekend'
    and trigger_bron = 'av_opvolging_automatisch';
  perform pg_temp.test_assert(v_log_count >= 1, 'AV -> neerlegging: the recalculation is logged with trigger_bron = av_opvolging_automatisch');
end $$;

-- ============================================================
-- 5. INSERT-time confidentiality guard (0009 regression test — closes the
-- High #4 follow-up from the security re-review of 0008: the original fix
-- only covered UPDATE of clients.vertrouwelijk/standaard_verantwoordelijke_id,
-- not INSERT). A plain medewerker must not be able to create a client that
-- is already vertrouwelijk=true or already has a
-- standaard_verantwoordelijke_id in the same INSERT; a kantoorbeheerder
-- can, and it must be logged to client_change_log same as the UPDATE path.
-- ============================================================
do $$
declare
  v_firm1 uuid := (select value from test_fixture_ids where key = 'firm1');
  v_admin_uid uuid := (select value from test_fixture_ids where key = 'admin_uid');
  v_admin_emp uuid := (select value from test_fixture_ids where key = 'admin_emp');
  v_medewerker_uid uuid;
  v_medewerker_emp uuid;
  v_client_id uuid;
  v_blocked boolean;
  v_log_count int;
begin
  insert into auth.users (email, email_confirmed_at) values ('medewerker@test.local', now()) returning id into v_medewerker_uid;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm1, v_medewerker_uid, 'Test Medewerker', 'medewerker@test.local', 'medewerker', false, true)
    returning id into v_medewerker_emp;

  -- Act as the plain medewerker.
  perform set_config('taskflow.test_uid', v_medewerker_uid::text, false);

  -- Note: standaard_verantwoordelijke_id is filled in here purely to
  -- satisfy the pre-existing `clients_confidential_needs_owner` CHECK
  -- constraint (0003, vertrouwelijk=true requires a non-null owner) so
  -- that constraint doesn't fire before our trigger does — the point of
  -- this assertion is specifically the vertrouwelijk=true block.
  v_blocked := false;
  begin
    insert into public.clients (
      firm_id, naam, ondernemingsnummer, boekjaar_einde_maand, boekjaar_einde_dag,
      btw_regime, vertrouwelijk, standaard_verantwoordelijke_id, actief
    ) values (
      v_firm1, 'Test Klant D (medewerker probeert vertrouwelijk)', 'BE0000.900.004', 12, 31, 'geen', true, v_admin_emp, true
    );
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  perform pg_temp.test_assert(v_blocked, 'INSERT guard: a plain medewerker cannot create a client with vertrouwelijk=true');

  v_blocked := false;
  begin
    insert into public.clients (
      firm_id, naam, ondernemingsnummer, boekjaar_einde_maand, boekjaar_einde_dag,
      btw_regime, vertrouwelijk, standaard_verantwoordelijke_id, actief
    ) values (
      v_firm1, 'Test Klant E (medewerker probeert standaard_verantwoordelijke)', 'BE0000.900.005', 12, 31, 'geen', false, v_admin_emp, true
    );
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  perform pg_temp.test_assert(v_blocked, 'INSERT guard: a plain medewerker cannot set standaard_verantwoordelijke_id at creation time either');

  -- A plain medewerker CAN still create a client with the safe defaults.
  insert into public.clients (
    firm_id, naam, ondernemingsnummer, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, vertrouwelijk, actief
  ) values (
    v_firm1, 'Test Klant F (medewerker, normale klant)', 'BE0000.900.006', 12, 31, 'geen', false, true
  ) returning id into v_client_id;
  perform pg_temp.test_assert(v_client_id is not null, 'INSERT guard: a plain medewerker can still create a non-confidential client');

  -- Act as the kantoorbeheerder: allowed, and audited.
  perform set_config('taskflow.test_uid', v_admin_uid::text, false);

  insert into public.clients (
    firm_id, naam, ondernemingsnummer, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, vertrouwelijk, standaard_verantwoordelijke_id, actief
  ) values (
    v_firm1, 'Test Klant G (kantoorbeheerder, meteen vertrouwelijk)', 'BE0000.900.007', 12, 31, 'geen', true, v_admin_emp, true
  ) returning id into v_client_id;
  perform pg_temp.test_assert(v_client_id is not null, 'INSERT guard: a kantoorbeheerder CAN create a client with vertrouwelijk=true directly');

  select count(*) into v_log_count
  from public.client_change_log
  where client_id = v_client_id and veld = 'vertrouwelijk' and oude_waarde is null and nieuwe_waarde = 'true';
  perform pg_temp.test_assert(v_log_count = 1, 'INSERT guard: creating a confidential client is logged in client_change_log (oude_waarde null)');

  select count(*) into v_log_count
  from public.client_change_log
  where client_id = v_client_id and veld = 'standaard_verantwoordelijke_id' and oude_waarde is null and nieuwe_waarde = v_admin_emp::text;
  perform pg_temp.test_assert(v_log_count = 1, 'INSERT guard: setting standaard_verantwoordelijke_id at creation is also logged');

  -- Restore admin as the acting session (matches the state expected by
  -- earlier sections, in case tests are ever reordered/extended below).
  perform set_config('taskflow.test_uid', v_admin_uid::text, false);
end $$;


-- ============================================================
-- Sectie 6: regressie op de zelf-refererende clients-policy (0010).
--
-- De SELECT-policy op `clients` mag de tabel niet opnieuw bevragen om te
-- beslissen of een rij zichtbaar is. Deed ze dat wel (via
-- can_access_client()), dan faalde ELKE `insert ... returning` -- en dus elke
-- klant die via de app werd aangemaakt -- met SQLSTATE 42501, omdat de
-- subquery binnen die functie de zojuist ingevoegde rij nog niet ziet.
-- PostgREST voegt RETURNING toe zodra de client `.insert(...).select()` doet,
-- dus dit trof de normale gebruiksweg volledig.
--
-- Dit is de eerste sectie die echt onder RLS draait (de vorige testen
-- functies/triggers als eigenaar). Vandaar de twee lokale voorbereidingen
-- hieronder: de rol `authenticated` bestaat niet vanzelf in een kale
-- Postgres, en de identiteit loopt lokaal via taskflow.test_uid (zie de
-- auth.uid()-stub in 00_local_auth_stub.sql) in plaats van via een JWT.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- Supabase geeft anon/authenticated standaard rechten op alles in `public`;
-- die twee regels bootsen dat na. In productie loopt migratie 0014 dáárna en
-- trekt de rechten op de dode kanban-tabellen weer in — hier moeten we die
-- volgorde met de hand herstellen, anders test sectie 21.9 een toestand die
-- alleen lokaal bestaat.
revoke all on public.boards, public.columns, public.labels, public.tasks, public.task_labels
  from anon, authenticated;

do $$
declare
  v_firm uuid; v_emp uuid; v_uid uuid := gen_random_uuid(); v_id uuid;
  v_vertrouwelijk_id uuid; v_cnt int;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 'rls-returning@test.local', now());
  insert into public.firms (naam) values ('RLS RETURNING testkantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
  values (v_firm, v_uid, 'Tester', 'rls-returning@test.local', 'kantoorbeheerder', true, true)
  returning id into v_emp;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;

  -- 6.1 De kern van de regressie: aanmaken MET RETURNING, zoals de app doet.
  insert into public.clients (
    firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, btw_aangifte_frequentie, mandataris, vertrouwelijk, actief
  ) values (
    v_firm, 'Klant via app', 12, 31, 'periodieke_aangever', 'kwartaal', false, false, true
  ) returning id into v_id;

  if v_id is null then
    raise exception 'FAIL 6.1: insert ... returning gaf geen id terug';
  end if;
  raise notice 'PASS 6.1: klant aanmaken met RETURNING werkt (geen 42501)';

  -- 6.2 Ook een vertrouwelijke klant, als kantoorbeheerder, met RETURNING.
  insert into public.clients (
    firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, mandataris, vertrouwelijk, standaard_verantwoordelijke_id, actief
  ) values (
    v_firm, 'Vertrouwelijke klant', 12, 31, 'geen', false, true, v_emp, true
  ) returning id into v_vertrouwelijk_id;
  raise notice 'PASS 6.2: vertrouwelijke klant aanmaken met RETURNING werkt';

  -- 6.3/6.4 De afscherming mag door de policy-herschrijving niet verzwakt
  -- zijn: als gewone medewerker zonder toegewezen taak blijft de
  -- vertrouwelijke klant onzichtbaar, gewone klanten blijven zichtbaar.
  set local role postgres;
  update public.employees set rol = 'medewerker' where id = v_emp;
  set local role authenticated;

  select count(*) into v_cnt from public.clients where id = v_vertrouwelijk_id;
  if v_cnt <> 0 then
    raise exception 'FAIL 6.3: vertrouwelijke klant zichtbaar (%) voor medewerker zonder toegewezen taak', v_cnt;
  end if;
  raise notice 'PASS 6.3: vertrouwelijke klant blijft afgeschermd zonder toewijzing';

  select count(*) into v_cnt from public.clients where id = v_id;
  if v_cnt <> 1 then
    raise exception 'FAIL 6.4: gewone klant niet zichtbaar voor medewerker (%)', v_cnt;
  end if;
  raise notice 'PASS 6.4: gewone klanten blijven zichtbaar voor een medewerker';

  -- 6.5 Zodra die medewerker een taak op de vertrouwelijke klant krijgt,
  -- hoort het dossier wel zichtbaar te worden (docs/PLAN.md 2.11).
  set local role postgres;
  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_vertrouwelijk_id,
    (select id from public.obligation_types where code = 'jaarafsluiting'),
    '2026', current_date, current_date, 'open', v_emp, 'automatisch_gegenereerd', true
  );
  perform set_config('taskflow.generating', 'off', true);
  set local role authenticated;

  select count(*) into v_cnt from public.clients where id = v_vertrouwelijk_id;
  if v_cnt <> 1 then
    raise exception 'FAIL 6.5: vertrouwelijke klant onzichtbaar (%) ondanks toegewezen taak', v_cnt;
  end if;
  raise notice 'PASS 6.5: toewijzing geeft toegang tot het vertrouwelijke dossier';

  set local role postgres;
end $$;


-- ============================================================
-- Secties 7-14: regressietests op de bevindingen uit de security-review
-- van 2026-08-25 (migratie 0011). Ze volgen het patroon van sectie 6: rol
-- `authenticated`, identiteit via taskflow.test_uid, echte schrijfacties in
-- plaats van policy-inspectie.
--
-- Elke sectie is bewust zelfvoorzienend (eigen kantoor, medewerkers,
-- klanten) zodat ze los van de rest kan draaien — dat is ook hoe
-- geverifieerd is dat elke test rood staat tegen de toestand vóór 0011.
-- ============================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end $$;

grant usage on schema public to authenticated, anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
-- Supabase geeft anon/authenticated standaard rechten op alles in `public`;
-- die twee regels bootsen dat na. In productie loopt migratie 0014 dáárna en
-- trekt de rechten op de dode kanban-tabellen weer in — hier moeten we die
-- volgorde met de hand herstellen, anders test sectie 21.9 een toestand die
-- alleen lokaal bestaat.
revoke all on public.boards, public.columns, public.labels, public.tasks, public.task_labels
  from anon, authenticated;

-- ============================================================
-- Sectie 7 (F-3): de goedkeuringsstap is niet te omzeilen en
-- goedgekeurd_door/goedgekeurd_op/afgerond_op zijn niet te vervalsen.
--
-- Gereproduceerd vóór 0011: een medewerker met mag_goedkeuren=false kon een
-- taak met vereist_goedkeuring=true rechtstreeks op 'ingediend_afgerond'
-- zetten, vereist_goedkeuring uitzetten, en zelf een goedkeurder + datum
-- invullen zonder dat task_status_log ooit 'goedkeuring_gegeven' zag.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin_uid uuid := gen_random_uuid(); v_admin uuid;
  v_mw_uid uuid := gen_random_uuid(); v_mw uuid;
  v_client uuid; v_client2 uuid; v_ot uuid; v_co uuid; v_task uuid;
  v_ok boolean; v_msg text;
  v_status public.task_status; v_vereist boolean;
  v_gd uuid; v_go timestamptz; v_ao timestamptz;
  v_bron public.taak_bron; v_label text; v_cid uuid; v_otid uuid; v_coid uuid;
  v_cnt int;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 'f3-admin@test.local', now());
  insert into auth.users (id, email, email_confirmed_at) values (v_mw_uid, 'f3-mw@test.local', now());
  insert into public.firms (naam) values ('F3 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'F3 Beheerder', 'f3-admin@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'F3 Medewerker', 'f3-mw@test.local', 'medewerker', false, true)
    returning id into v_mw;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'F3 Klant', 12, 31, 'geen', false, true) returning id into v_client;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'F3 Klant 2', 12, 31, 'geen', false, true) returning id into v_client2;

  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
    values (v_client, v_ot, true, current_date, v_mw) returning id into v_co;

  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, client_obligation_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, v_co, '2029', current_date + 30, current_date + 30,
    'open', v_mw, 'automatisch_gegenereerd', true
  ) returning id into v_task;
  perform set_config('taskflow.generating', 'off', true);

  -- Vanaf hier: de medewerker zonder goedkeuringsrecht, onder RLS.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;

  -- 7.1 De normale eerste stap moet gewoon werken.
  update public.task_instances set status = 'in_uitvoering' where id = v_task;
  select status into v_status from public.task_instances where id = v_task;
  if v_status <> 'in_uitvoering' then
    raise exception 'FAIL 7.1: open -> in_uitvoering werkte niet (status=%)', v_status;
  end if;
  raise notice 'PASS 7.1: open -> in_uitvoering blijft toegelaten';

  -- 7.2 Rechtstreeks afronden met vereist_goedkeuring=true moet falen.
  v_ok := false;
  begin
    update public.task_instances set status = 'ingediend_afgerond' where id = v_task;
  exception when others then v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok then
    raise exception 'FAIL 7.2: goedkeuringsstap werd overgeslagen (direct naar ingediend_afgerond)';
  end if;
  select status into v_status from public.task_instances where id = v_task;
  if v_status <> 'in_uitvoering' then
    raise exception 'FAIL 7.2: status toch gewijzigd naar %', v_status;
  end if;
  raise notice 'PASS 7.2: rechtstreeks afronden is geblokkeerd (%)', left(v_msg, 60);

  -- 7.3 vereist_goedkeuring is bevroren op aanmaakmoment (PLAN 2.7).
  update public.task_instances set vereist_goedkeuring = false where id = v_task;
  select vereist_goedkeuring into v_vereist from public.task_instances where id = v_task;
  if v_vereist is not true then
    raise exception 'FAIL 7.3: vereist_goedkeuring kon uitgezet worden';
  end if;
  raise notice 'PASS 7.3: vereist_goedkeuring blijft bevroren op true';

  -- 7.4 Goedkeurings-/afrondingsstempels zijn niet zelf in te vullen.
  update public.task_instances
  set goedgekeurd_door = v_mw, goedgekeurd_op = now() - interval '40 days', afgerond_op = now() - interval '40 days'
  where id = v_task;
  select goedgekeurd_door, goedgekeurd_op, afgerond_op into v_gd, v_go, v_ao
  from public.task_instances where id = v_task;
  if v_gd is not null or v_go is not null or v_ao is not null then
    raise exception 'FAIL 7.4: goedgekeurd_door/goedgekeurd_op/afgerond_op waren vervalsbaar (%, %, %)', v_gd, v_go, v_ao;
  end if;
  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_task and event_type = 'goedkeuring_gegeven';
  if v_cnt <> 0 then
    raise exception 'FAIL 7.4: er staat een goedkeuring in het log zonder echte goedkeuring';
  end if;
  raise notice 'PASS 7.4: goedkeurings-/afrondingsstempels worden altijd door de trigger gezet';

  -- 7.5 Onveranderlijke herkomstkolommen zijn vastgepind.
  update public.task_instances
  set bron_type = 'handmatig_adhoc', client_id = v_client2, obligation_type_id = null,
      client_obligation_id = null, periode_label = 'gemanipuleerd'
  where id = v_task;
  select bron_type, client_id, obligation_type_id, client_obligation_id, periode_label
  into v_bron, v_cid, v_otid, v_coid, v_label
  from public.task_instances where id = v_task;
  if v_bron <> 'automatisch_gegenereerd' or v_cid <> v_client or v_otid is null
     or v_coid is null or v_label <> '2029' then
    raise exception 'FAIL 7.5: herkomstkolommen waren wijzigbaar (%, %, %, %, %)', v_bron, v_cid, v_otid, v_coid, v_label;
  end if;
  raise notice 'PASS 7.5: bron_type/client_id/obligation_type_id/client_obligation_id/periode_label zijn bevroren';

  -- 7.6 Terug naar 'open' staat niet in de whitelist van PLAN 2.7.
  v_ok := false;
  begin
    update public.task_instances set status = 'open' where id = v_task;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 7.6: niet-toegelaten overgang in_uitvoering -> open werd aanvaard';
  end if;
  raise notice 'PASS 7.6: niet-gewhiteliste statusovergang wordt geweigerd';

  -- 7.7 Wel naar wacht_op_goedkeuring, maar er niet zelf uit.
  update public.task_instances set status = 'wacht_op_goedkeuring' where id = v_task;
  v_ok := false;
  begin
    update public.task_instances set status = 'ingediend_afgerond' where id = v_task;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 7.7: medewerker zonder mag_goedkeuren kon zelf goedkeuren';
  end if;
  raise notice 'PASS 7.7: enkel mag_goedkeuren mag uit wacht_op_goedkeuring';

  -- 7.8 De echte goedkeurder: stempels + logregel komen van de trigger.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  update public.task_instances set status = 'ingediend_afgerond' where id = v_task;
  select goedgekeurd_door, goedgekeurd_op, afgerond_op into v_gd, v_go, v_ao
  from public.task_instances where id = v_task;
  if v_gd <> v_admin or v_go is null or v_ao is null then
    raise exception 'FAIL 7.8: goedkeuring niet correct gestempeld (%, %, %)', v_gd, v_go, v_ao;
  end if;
  if v_go < now() - interval '1 minute' or v_ao < now() - interval '1 minute' then
    raise exception 'FAIL 7.8: stempels werden niet op nu gezet';
  end if;
  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_task and event_type = 'goedkeuring_gegeven' and actor_employee_id = v_admin;
  if v_cnt <> 1 then
    raise exception 'FAIL 7.8: goedkeuring_gegeven ontbreekt in het log (%)', v_cnt;
  end if;
  raise notice 'PASS 7.8: goedkeuren door een bevoegde medewerker stempelt en logt correct';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 8 (F-4): due_date is handmatig aanpasbaar, maar nooit stil.
-- due_date_wettelijk blijft voorbehouden aan de kalenderpijplijn.
--
-- Gereproduceerd vóór 0011: `update task_instances set due_date='2099-12-31'`
-- slaagde met 0 nieuwe logregels.
-- ============================================================
do $$
declare
  v_firm uuid; v_uid uuid := gen_random_uuid(); v_emp uuid;
  v_client uuid; v_ot uuid; v_task uuid;
  v_oude date; v_cnt int; v_ok boolean; v_wettelijk date; v_notitie text; v_bron public.log_trigger_bron;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 'f4@test.local', now());
  insert into public.firms (naam) values ('F4 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'F4 Medewerker', 'f4@test.local', 'medewerker', false, true) returning id into v_emp;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'F4 Klant', 12, 31, 'geen', false, true) returning id into v_client;
  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';
  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, '2030', date '2030-04-15', date '2030-04-15',
    'open', v_emp, 'automatisch_gegenereerd', true
  ) returning id into v_task;
  perform set_config('taskflow.generating', 'off', true);
  v_oude := date '2030-04-15';

  set local role authenticated;

  -- 8.1 Handmatig verschuiven mag, maar levert altijd een logregel op.
  update public.task_instances set due_date = date '2099-12-31' where id = v_task;

  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_task and event_type = 'due_date_herberekend';
  if v_cnt <> 1 then
    raise exception 'FAIL 8.1: handmatige due_date-wijziging leverde % logregels op (verwacht 1)', v_cnt;
  end if;

  select oude_due_date, nieuwe_due_date, trigger_bron, notitie into v_oude, v_wettelijk, v_bron, v_notitie
  from public.task_status_log
  where task_instance_id = v_task and event_type = 'due_date_herberekend'
  order by created_at desc limit 1;
  if v_oude <> date '2030-04-15' or v_wettelijk <> date '2099-12-31'
     or v_bron <> 'medewerker_actie' or v_notitie is distinct from 'Handmatig aangepast' then
    raise exception 'FAIL 8.1: logregel onvolledig (% -> %, %, %)', v_oude, v_wettelijk, v_bron, v_notitie;
  end if;
  raise notice 'PASS 8.1: handmatige due_date-wijziging wordt volledig gelogd';

  -- 8.2 De ruwe wettelijke datum blijft van de kalenderpijplijn.
  v_ok := false;
  begin
    update public.task_instances set due_date_wettelijk = date '2099-12-31' where id = v_task;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 8.2: due_date_wettelijk was rechtstreeks wijzigbaar';
  end if;
  select due_date_wettelijk into v_wettelijk from public.task_instances where id = v_task;
  if v_wettelijk <> date '2030-04-15' then
    raise exception 'FAIL 8.2: due_date_wettelijk toch gewijzigd naar %', v_wettelijk;
  end if;
  raise notice 'PASS 8.2: due_date_wettelijk kan enkel door de kalenderpijplijn wijzigen';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 9 (F-5): public_holidays is append-only; corrigeren gebeurt door
-- intrekken (nieuwe rij voor de juiste datum), mét herberekening én logregel.
--
-- Gereproduceerd vóór 0011: een feestdag toevoegen schoof de deadline
-- correct door, maar diezelfde rij nadien corrigeren (UPDATE, toegelaten
-- door de 0005-policy) liet de foute deadline staan en logde niets.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin_uid uuid := gen_random_uuid(); v_admin uuid;
  v_mw_uid uuid := gen_random_uuid(); v_mw uuid;
  v_client uuid; v_ot uuid; v_task uuid;
  v_woensdag date := date_trunc('week', date '2031-05-05')::date + 2;
  v_holiday uuid; v_rows int; v_due date; v_cnt int; v_ok boolean; v_ingetrokken boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 'f5-admin@test.local', now());
  insert into auth.users (id, email, email_confirmed_at) values (v_mw_uid, 'f5-mw@test.local', now());
  insert into public.firms (naam) values ('F5 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'F5 Beheerder', 'f5-admin@test.local', 'kantoorbeheerder', true, true) returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'F5 Medewerker', 'f5-mw@test.local', 'medewerker', false, true) returning id into v_mw;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'F5 Klant', 12, 31, 'geen', false, true) returning id into v_client;
  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';
  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, '2031', v_woensdag, v_woensdag, 'open', v_admin, 'automatisch_gegenereerd', true
  ) returning id into v_task;
  perform set_config('taskflow.generating', 'off', true);

  set local role authenticated;

  -- 9.1 Toevoegen schuift de deadline door en logt (bestaand gedrag, blijft).
  insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
    values (2031, v_woensdag, 'F5 foutieve feestdag', v_admin, v_admin) returning id into v_holiday;

  select due_date into v_due from public.task_instances where id = v_task;
  if v_due <> v_woensdag + 1 then
    raise exception 'FAIL 9.1: deadline schoof niet door naar de volgende werkdag (%)', v_due;
  end if;
  raise notice 'PASS 9.1: nieuwe feestdag schuift de deadline door';

  -- 9.2 De rij zelf is niet meer overschrijfbaar: geen UPDATE-policy meer.
  update public.public_holidays set datum = v_woensdag + 1 where id = v_holiday;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'FAIL 9.2: feestdagrij was rechtstreeks overschrijfbaar (% rijen)', v_rows;
  end if;
  raise notice 'PASS 9.2: public_holidays is append-only (UPDATE raakt 0 rijen)';

  -- 9.3 Intrekken kan enkel als kantoorbeheerder.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  v_ok := false;
  begin
    perform public.retract_public_holiday(v_holiday, 'poging door gewone medewerker');
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 9.3: een gewone medewerker kon een feestdag intrekken';
  end if;
  raise notice 'PASS 9.3: intrekken is voorbehouden aan de kantoorbeheerder';

  -- 9.4 Intrekken herberekent terug én laat een spoor na.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  perform public.retract_public_holiday(v_holiday, 'Verkeerde datum ingevoerd');

  select ingetrokken into v_ingetrokken from public.public_holidays where id = v_holiday;
  if v_ingetrokken is not true then
    raise exception 'FAIL 9.4: feestdag niet gemarkeerd als ingetrokken';
  end if;
  select due_date into v_due from public.task_instances where id = v_task;
  if v_due <> v_woensdag then
    raise exception 'FAIL 9.4: deadline werd niet herberekend na intrekking (%)', v_due;
  end if;
  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_task and event_type = 'due_date_herberekend'
    and trigger_bron = 'kalender_herberekening' and notitie ilike '%ingetrokken%';
  if v_cnt <> 1 then
    raise exception 'FAIL 9.4: intrekking leverde % logregels op (verwacht 1)', v_cnt;
  end if;
  raise notice 'PASS 9.4: intrekken herberekent de deadline en logt de correctie';

  -- 9.5 De juiste datum komt er als NIEUWE rij bij (legal_calendar-patroon),
  -- ook wanneer die dezelfde datum betreft als een ingetrokken rij.
  insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
    values (2031, v_woensdag, 'F5 gecorrigeerde feestdag', v_admin, v_admin);
  select due_date into v_due from public.task_instances where id = v_task;
  if v_due <> v_woensdag + 1 then
    raise exception 'FAIL 9.5: correctierij herberekende de deadline niet (%)', v_due;
  end if;
  raise notice 'PASS 9.5: correctie = nieuwe rij, met herberekening';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 10 (F-7): deadline-bepalende klantvelden en client_obligations
-- zijn niet langer ongeaudit wijzigbaar.
-- ============================================================
do $$
declare
  v_firm uuid; v_uid uuid := gen_random_uuid(); v_emp uuid;
  v_admin_uid uuid := gen_random_uuid(); v_admin uuid;
  v_client uuid; v_co uuid; v_cnt int;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 'f7-admin@test.local', now());
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 'f7-mw@test.local', now());
  insert into public.firms (naam) values ('F7 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'F7 Beheerder', 'f7-admin@test.local', 'kantoorbeheerder', true, true) returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'F7 Medewerker', 'f7-mw@test.local', 'medewerker', false, true) returning id into v_emp;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (
    firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, btw_aangifte_frequentie, vertrouwelijk, actief
  ) values (v_firm, 'F7 Klant', 12, 31, 'periodieke_aangever', 'kwartaal', false, true) returning id into v_client;

  select co.id into v_co from public.client_obligations co
  join public.obligation_types ot on ot.id = co.obligation_type_id
  where co.client_id = v_client and ot.code = 'btw_aangifte';

  -- Vanaf hier als gewone medewerker: bewerken mag (dossierwerk), maar wordt gelogd.
  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;

  -- 10.1 boekjaareinde
  update public.clients set boekjaar_einde_maand = 6, boekjaar_einde_dag = 30 where id = v_client;
  select count(*) into v_cnt from public.client_change_log
  where client_id = v_client and veld = 'boekjaar_einde_maand'
    and oude_waarde = '12' and nieuwe_waarde = '6' and actor_employee_id = v_emp;
  if v_cnt <> 1 then
    raise exception 'FAIL 10.1: wijziging van boekjaar_einde_maand niet geaudit (%)', v_cnt;
  end if;
  select count(*) into v_cnt from public.client_change_log
  where client_id = v_client and veld = 'boekjaar_einde_dag' and nieuwe_waarde = '30';
  if v_cnt <> 1 then
    raise exception 'FAIL 10.1: wijziging van boekjaar_einde_dag niet geaudit (%)', v_cnt;
  end if;
  raise notice 'PASS 10.1: boekjaareinde-wijziging staat in client_change_log';

  -- 10.2 btw-frequentie (stuurt de hele BTW-generatie aan)
  update public.clients set btw_aangifte_frequentie = 'maand' where id = v_client;
  select count(*) into v_cnt from public.client_change_log
  where client_id = v_client and veld = 'btw_aangifte_frequentie'
    and oude_waarde = 'kwartaal' and nieuwe_waarde = 'maand';
  if v_cnt <> 1 then
    raise exception 'FAIL 10.2: wijziging van btw_aangifte_frequentie niet geaudit (%)', v_cnt;
  end if;
  raise notice 'PASS 10.2: btw_aangifte_frequentie-wijziging staat in client_change_log';

  -- 10.3 btw_regime + actief
  update public.clients set btw_regime = 'geen', btw_aangifte_frequentie = null where id = v_client;
  select count(*) into v_cnt from public.client_change_log
  where client_id = v_client and veld = 'btw_regime' and nieuwe_waarde = 'geen';
  if v_cnt <> 1 then
    raise exception 'FAIL 10.3: wijziging van btw_regime niet geaudit (%)', v_cnt;
  end if;

  update public.clients set actief = false where id = v_client;
  select count(*) into v_cnt from public.client_change_log
  where client_id = v_client and veld = 'actief' and oude_waarde = 'true' and nieuwe_waarde = 'false';
  if v_cnt <> 1 then
    raise exception 'FAIL 10.3: deactiveren van een klant niet geaudit (%)', v_cnt;
  end if;
  raise notice 'PASS 10.3: btw_regime en actief worden geaudit';

  -- 10.4 client_obligations: parameters + activeren/deactiveren
  update public.client_obligations set parameters = jsonb_build_object('frequentie', 'maand', 'handmatig', true)
  where id = v_co;
  select count(*) into v_cnt from public.client_change_log
  where client_obligation_id = v_co and veld = 'verplichting_parameters' and actor_employee_id = v_emp;
  if v_cnt < 1 then
    raise exception 'FAIL 10.4: parameterwijziging op client_obligations niet geaudit';
  end if;

  update public.client_obligations set actief = false, geldig_tot = current_date where id = v_co;
  select count(*) into v_cnt from public.client_change_log
  where client_obligation_id = v_co and veld = 'verplichting_actief'
    and oude_waarde = 'true' and nieuwe_waarde = 'false';
  if v_cnt <> 1 then
    raise exception 'FAIL 10.4: deactiveren van een verplichting niet geaudit (%)', v_cnt;
  end if;
  raise notice 'PASS 10.4: client_obligations-wijzigingen staan in client_change_log';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 11 (F-8): de laatste actieve kantoorbeheerder kan zichzelf niet
-- deactiveren.
-- ============================================================
do $$
declare
  v_firm uuid; v_a_uid uuid := gen_random_uuid(); v_a uuid;
  v_b_uid uuid := gen_random_uuid(); v_b uuid;
  v_ok boolean; v_actief boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_a_uid, 'f8-a@test.local', now());
  insert into auth.users (id, email, email_confirmed_at) values (v_b_uid, 'f8-b@test.local', now());
  insert into public.firms (naam) values ('F8 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_a_uid, 'F8 Beheerder A', 'f8-a@test.local', 'kantoorbeheerder', true, true) returning id into v_a;

  perform set_config('taskflow.test_uid', v_a_uid::text, true);
  set local role authenticated;

  -- 11.1 Enige kantoorbeheerder: deactiveren moet geweigerd worden.
  v_ok := false;
  begin
    update public.employees set actief = false where id = v_a;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 11.1: de laatste kantoorbeheerder kon zichzelf deactiveren';
  end if;
  select actief into v_actief from public.employees where id = v_a;
  if v_actief is not true then
    raise exception 'FAIL 11.1: kantoorbeheerder staat toch op inactief';
  end if;
  raise notice 'PASS 11.1: laatste kantoorbeheerder kan zichzelf niet deactiveren';

  -- 11.2 Met een tweede kantoorbeheerder mag het wel.
  set local role postgres;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_b_uid, 'F8 Beheerder B', 'f8-b@test.local', 'kantoorbeheerder', true, true) returning id into v_b;
  set local role authenticated;

  update public.employees set actief = false where id = v_a;
  select actief into v_actief from public.employees where id = v_a;
  if v_actief is not false then
    raise exception 'FAIL 11.2: deactiveren lukte niet ondanks een tweede kantoorbeheerder';
  end if;
  raise notice 'PASS 11.2: deactiveren lukt zodra er een tweede kantoorbeheerder is';

  -- 11.3 En dan is B de laatste, dus die zit weer vast.
  perform set_config('taskflow.test_uid', v_b_uid::text, true);
  v_ok := false;
  begin
    update public.employees set actief = false where id = v_b;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 11.3: de overblijvende kantoorbeheerder kon zichzelf deactiveren';
  end if;
  raise notice 'PASS 11.3: de overblijvende kantoorbeheerder blijft geblokkeerd';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 12 (F-9): niets is toewijsbaar aan een medewerker van een ander
-- kantoor.
-- ============================================================
do $$
declare
  v_firm_a uuid; v_firm_b uuid;
  v_a_uid uuid := gen_random_uuid(); v_emp_a uuid;
  v_b_uid uuid := gen_random_uuid(); v_emp_b uuid;
  v_client uuid; v_ot uuid; v_task uuid; v_ok boolean; v_toegewezen uuid;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_a_uid, 'f9-a@test.local', now());
  insert into auth.users (id, email, email_confirmed_at) values (v_b_uid, 'f9-b@test.local', now());
  insert into public.firms (naam) values ('F9 kantoor A') returning id into v_firm_a;
  insert into public.firms (naam) values ('F9 kantoor B') returning id into v_firm_b;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm_a, v_a_uid, 'F9 Beheerder A', 'f9-a@test.local', 'kantoorbeheerder', true, true) returning id into v_emp_a;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm_b, v_b_uid, 'F9 Beheerder B', 'f9-b@test.local', 'kantoorbeheerder', true, true) returning id into v_emp_b;

  perform set_config('taskflow.test_uid', v_a_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm_a, 'F9 Klant van kantoor A', 12, 31, 'geen', false, true) returning id into v_client;
  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';

  -- 12.1 Aanmaken met een medewerker van het andere kantoor.
  v_ok := false;
  begin
    -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
    perform set_config('taskflow.generating', 'on', true);
    insert into public.task_instances (
      client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
      status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
    ) values (
      v_client, v_ot, '2032-x', current_date + 10, current_date + 10,
      'open', v_emp_b, 'automatisch_gegenereerd', true
    );
    perform set_config('taskflow.generating', 'off', true);
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 12.1: taak aangemaakt voor een medewerker van een ander kantoor';
  end if;
  raise notice 'PASS 12.1: taak aanmaken over de kantoorgrens heen wordt geweigerd';

  -- 12.2 Herverdelen naar het andere kantoor.
  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, '2032', current_date + 10, current_date + 10,
    'open', v_emp_a, 'automatisch_gegenereerd', true
  ) returning id into v_task;
  perform set_config('taskflow.generating', 'off', true);

  v_ok := false;
  begin
    update public.task_instances set toegewezen_medewerker_id = v_emp_b where id = v_task;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 12.2: taak herverdeeld naar een medewerker van een ander kantoor';
  end if;
  select toegewezen_medewerker_id into v_toegewezen from public.task_instances where id = v_task;
  if v_toegewezen <> v_emp_a then
    raise exception 'FAIL 12.2: toewijzing toch gewijzigd';
  end if;
  raise notice 'PASS 12.2: herverdelen over de kantoorgrens heen wordt geweigerd';

  -- 12.2b Ook niet via een gelijktijdig meegestuurde client_id van kantoor B.
  v_ok := false;
  begin
    update public.task_instances
    set toegewezen_medewerker_id = v_emp_b, client_id = gen_random_uuid()
    where id = v_task;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 12.2b: kantoorgrens omzeilbaar door client_id mee te sturen';
  end if;
  raise notice 'PASS 12.2b: client_id meesturen omzeilt de kantoorgrens niet';

  -- 12.3 client_obligations.standaard_toegewezen_medewerker_id
  v_ok := false;
  begin
    insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
    values (v_client, v_ot, true, current_date, v_emp_b);
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 12.3: verplichting toegewezen aan een medewerker van een ander kantoor';
  end if;
  raise notice 'PASS 12.3: client_obligations respecteert de kantoorgrens';

  -- 12.4 clients.standaard_verantwoordelijke_id
  v_ok := false;
  begin
    update public.clients set standaard_verantwoordelijke_id = v_emp_b where id = v_client;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 12.4: standaard verantwoordelijke van een ander kantoor toegelaten';
  end if;
  raise notice 'PASS 12.4: clients.standaard_verantwoordelijke_id respecteert de kantoorgrens';

  -- 12.5 Sanity: binnen hetzelfde kantoor blijft alles gewoon werken.
  update public.clients set standaard_verantwoordelijke_id = v_emp_a where id = v_client;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
  values (v_client, v_ot, true, current_date, v_emp_a);
  raise notice 'PASS 12.5: binnen hetzelfde kantoor blijft toewijzen gewoon mogelijk';
end $$;

-- ============================================================
-- Sectie 13 (F-1): task_instances_select/_update zijn rij-gebaseerd, maar
-- de escalatie via task_instances_insert blijft dicht.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin_uid uuid := gen_random_uuid(); v_admin uuid;
  v_mw_uid uuid := gen_random_uuid(); v_mw uuid;
  v_client uuid; v_client2 uuid; v_ot uuid; v_t1 uuid; v_t2 uuid; v_new uuid;
  v_cnt int; v_ok boolean; v_returned uuid; v_state text;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 'f1-admin@test.local', now());
  insert into auth.users (id, email, email_confirmed_at) values (v_mw_uid, 'f1-mw@test.local', now());
  insert into public.firms (naam) values ('F1 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'F1 Beheerder', 'f1-admin@test.local', 'kantoorbeheerder', true, true) returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'F1 Medewerker', 'f1-mw@test.local', 'medewerker', false, true) returning id into v_mw;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, standaard_verantwoordelijke_id, actief)
    values (v_firm, 'F1 Vertrouwelijke klant', 12, 31, 'geen', true, v_admin, true) returning id into v_client;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, standaard_verantwoordelijke_id, actief)
    values (v_firm, 'F1 Andere vertrouwelijke klant', 12, 31, 'geen', true, v_admin, true) returning id into v_client2;
  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';

  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (v_client, v_ot, '2033-a', current_date + 20, current_date + 20, 'open', v_mw, 'automatisch_gegenereerd', true)
  returning id into v_t1;
  perform set_config('taskflow.generating', 'off', true);

  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (v_client, v_ot, '2033-b', current_date + 25, current_date + 25, 'open', v_admin, 'automatisch_gegenereerd', true)
  returning id into v_t2;
  perform set_config('taskflow.generating', 'off', true);

  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;

  -- 13.1 De eigen taak op een vertrouwelijke klant is zichtbaar.
  select count(*) into v_cnt from public.task_instances where id = v_t1;
  if v_cnt <> 1 then
    raise exception 'FAIL 13.1: eigen taak op vertrouwelijke klant onzichtbaar';
  end if;
  raise notice 'PASS 13.1: eigen taak blijft zichtbaar (rij-gebaseerd)';

  -- 13.2 De dossier-brede regel van PLAN 2.11 blijft overeind: een collega's
  -- taak bij dezelfde klant blijft zichtbaar zodra je zelf een taak hebt.
  select count(*) into v_cnt from public.task_instances where id = v_t2;
  if v_cnt <> 1 then
    raise exception 'FAIL 13.2: andere taak op hetzelfde dossier onzichtbaar geworden';
  end if;
  raise notice 'PASS 13.2: dossier-brede zichtbaarheid blijft behouden';

  -- 13.3 UPDATE ... RETURNING op de eigen taak werkt (dit is precies wat de
  -- app doet en waar de zelf-refererende constructie op stukliep).
  update public.task_instances set status = 'in_uitvoering' where id = v_t1 returning id into v_returned;
  if v_returned is null then
    raise exception 'FAIL 13.3: update ... returning gaf niets terug';
  end if;
  raise notice 'PASS 13.3: update ... returning werkt op de eigen taakrij';

  -- 13.4 Escalatie blijft dicht: een medewerker mag zichzelf GEEN taak
  -- toewijzen op een vertrouwelijke klant die hij niet mag zien.
  v_ok := false;
  begin
    -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
    perform set_config('taskflow.generating', 'on', true);
    insert into public.task_instances (
      client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
      status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
    ) values (v_client2, v_ot, '2033-c', current_date + 30, current_date + 30, 'open', v_mw, 'automatisch_gegenereerd', true)
    returning id into v_new;
    perform set_config('taskflow.generating', 'off', true);
  exception when others then v_ok := true; v_state := sqlstate;
  end;
  if not v_ok then
    raise exception 'FAIL 13.4: medewerker kon zichzelf een taak toewijzen op een onzichtbaar vertrouwelijk dossier';
  end if;
  if v_state <> '42501' then
    raise exception 'FAIL 13.4: insert geweigerd om de verkeerde reden (sqlstate %)', v_state;
  end if;
  raise notice 'PASS 13.4: zelf-toewijzing op een vertrouwelijk dossier blijft geblokkeerd (42501)';

  -- 13.5 En dat dossier blijft volledig onzichtbaar.
  select count(*) into v_cnt from public.clients where id = v_client2;
  if v_cnt <> 0 then
    raise exception 'FAIL 13.5: onzichtbaar vertrouwelijk dossier toch zichtbaar';
  end if;
  select count(*) into v_cnt from public.task_instances where client_id = v_client2;
  if v_cnt <> 0 then
    raise exception 'FAIL 13.5: taken van een onzichtbaar vertrouwelijk dossier toch zichtbaar';
  end if;
  raise notice 'PASS 13.5: het vreemde vertrouwelijke dossier blijft afgeschermd';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 14 (F-12/F-13): helperfuncties niet meer EXECUTE-baar door
-- PUBLIC/anon, en client_obligations.parameters is begrensd.
-- ============================================================
do $$
declare
  v_firm uuid; v_uid uuid := gen_random_uuid(); v_emp uuid;
  v_client uuid; v_ot uuid; v_co uuid; v_ok boolean;
begin
  -- 14.1 F-12
  if has_function_privilege('anon', 'public.can_view_client(uuid, uuid)', 'execute') then
    raise exception 'FAIL 14.1: can_view_client() is nog EXECUTE-baar via PUBLIC/anon';
  end if;
  if has_function_privilege('anon', 'public.can_access_client(uuid)', 'execute') then
    raise exception 'FAIL 14.1: can_access_client() is nog EXECUTE-baar via PUBLIC/anon';
  end if;
  if not has_function_privilege('authenticated', 'public.can_access_client(uuid)', 'execute') then
    raise exception 'FAIL 14.1: authenticated verloor EXECUTE op can_access_client()';
  end if;
  raise notice 'PASS 14.1: can_view_client()/can_access_client() zijn niet langer publiek uitvoerbaar';

  -- 14.2 F-13
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 'f13@test.local', now());
  insert into public.firms (naam) values ('F13 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'F13 Beheerder', 'f13@test.local', 'kantoorbeheerder', true, true) returning id into v_emp;
  perform set_config('taskflow.test_uid', v_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'F13 Klant', 12, 31, 'geen', false, true) returning id into v_client;
  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';

  v_ok := false;
  begin
    insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters)
    values (v_client, v_ot, true, current_date, jsonb_build_object('blob', repeat('x', 1000000)));
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 14.2: een jsonb van 1 MB werd aanvaard in client_obligations.parameters';
  end if;
  raise notice 'PASS 14.2: client_obligations.parameters is begrensd';

  -- Normale parameters blijven gewoon werken.
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters)
  values (v_client, v_ot, true, current_date, jsonb_build_object('frequentie', 'kwartaal', 'termijn_dagen', 10))
  returning id into v_co;
  if v_co is null then
    raise exception 'FAIL 14.2: normale parameters werden geweigerd';
  end if;
  raise notice 'PASS 14.2b: normale parameters blijven toegelaten';
end $$;

-- ============================================================
-- Secties 15-19: regressietests op de tweede security-review (migratie
-- 0012). Zelfde patroon als 7-14: rol `authenticated`, identiteit via
-- taskflow.test_uid, echte schrijfacties als gewone medewerker in plaats
-- van policy-inspectie. Elke sectie is zelfvoorzienend en is geverifieerd
-- rood tegen een database met enkel 0001-0011.
-- ============================================================

-- ============================================================
-- Sectie 15 (B-1): de AV-pijplijn is niet te kapen via voorloper_taak_id.
--
-- Gereproduceerd vóór 0012: een medewerker maakte een eigen AV-taak, zette
-- `voorloper_taak_id` van de taak van een collega daarop (1 rij, 0
-- logregels), rondde zijn eigen AV af en herschreef zo de wettelijke
-- deadline van die collega — geboekt als systeemgebeurtenis
-- (trigger_bron = av_opvolging_automatisch).
-- ============================================================
do $$
declare
  v_firm uuid; v_admin_uid uuid := gen_random_uuid(); v_admin uuid;
  v_mw_uid uuid := gen_random_uuid(); v_mw uuid;
  v_client uuid; v_client2 uuid;
  v_ot_av uuid; v_ot_neer uuid;
  v_av_echt uuid; v_neerlegging uuid; v_av_aanvaller uuid;
  v_voorloper uuid; v_wettelijk date; v_due date; v_cnt int; v_ok boolean;
  v_voorlopig boolean; v_afgerond date;
  v_av_due date := date '2044-06-30';
  v_neer_due date := date '2044-07-30';
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 'b1-admin@test.local', now());
  insert into auth.users (id, email, email_confirmed_at) values (v_mw_uid, 'b1-mw@test.local', now());
  insert into public.firms (naam) values ('B1 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'B1 Beheerder', 'b1-admin@test.local', 'kantoorbeheerder', true, true) returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'B1 Medewerker', 'b1-mw@test.local', 'medewerker', false, true) returning id into v_mw;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'B1 Klant', 12, 31, 'geen', false, true) returning id into v_client;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'B1 Klant 2', 12, 31, 'geen', false, true) returning id into v_client2;

  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';
  select id into v_ot_neer from public.obligation_types where code = 'neerlegging_jaarrekening';

  -- De échte keten van de collega: AV-taak + gekoppelde neerlegging.
  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, periode_start, periode_eind,
    due_date, due_date_wettelijk, status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot_av, '2044', date '2043-12-31', date '2043-12-31',
    v_av_due, v_av_due, 'open', v_admin, 'automatisch_gegenereerd', true
  ) returning id into v_av_echt;
  perform set_config('taskflow.generating', 'off', true);

  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, periode_start, periode_eind,
    due_date, due_date_wettelijk, status, toegewezen_medewerker_id, bron_type,
    vereist_goedkeuring, voorlopige_datum, voorloper_taak_id
  ) values (
    v_client, v_ot_neer, '2044', date '2043-12-31', date '2043-12-31',
    v_neer_due, v_neer_due, 'open', v_admin, 'automatisch_gegenereerd', true, true, v_av_echt
  ) returning id into v_neerlegging;
  perform set_config('taskflow.generating', 'off', true);

  -- Vanaf hier: de aanvaller is een gewone medewerker onder RLS.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;

  -- 15.1 Een eigen AV-taak aanmaken mag gewoon (dat is de opstap).
  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot_av, '2044-eigen', current_date + 5, current_date + 5,
    'open', v_mw, 'automatisch_gegenereerd', false
  ) returning id into v_av_aanvaller;
  perform set_config('taskflow.generating', 'off', true);
  raise notice 'PASS 15.1: eigen AV-taak aanmaken blijft mogelijk (opstap van de aanval)';

  -- 15.2 De voorloper van de taak van een collega kapen moet onmogelijk zijn.
  -- Sinds 0013 wordt dat luid geweigerd i.p.v. stil teruggedraaid: een
  -- stille reset laat de gebruiker denken dat de wijziging bewaard is.
  v_ok := false;
  begin
    update public.task_instances set voorloper_taak_id = v_av_aanvaller where id = v_neerlegging;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 15.2: het herkoppelen van voorloper_taak_id werd niet geweigerd';
  end if;
  select voorloper_taak_id into v_voorloper from public.task_instances where id = v_neerlegging;
  if v_voorloper is distinct from v_av_echt then
    raise exception 'FAIL 15.2: voorloper_taak_id was herkoppelbaar (% i.p.v. %)', v_voorloper, v_av_echt;
  end if;
  raise notice 'PASS 15.2: voorloper_taak_id is bevroren (luide weigering)';

  -- 15.3 De eigen AV afronden mag de collega-taak niet verplaatsen — niet
  -- rechtstreeks, en ook niet via de goedkeuringsroute.
  begin
    update public.task_instances set status = 'ingediend_afgerond' where id = v_av_aanvaller;
  exception when others then null;
  end;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  begin
    update public.task_instances set status = 'wacht_op_goedkeuring' where id = v_av_aanvaller;
  exception when others then null;
  end;
  begin
    update public.task_instances set status = 'ingediend_afgerond' where id = v_av_aanvaller;
  exception when others then null;
  end;

  select due_date_wettelijk, due_date, voorlopige_datum
    into v_wettelijk, v_due, v_voorlopig
  from public.task_instances where id = v_neerlegging;
  if v_wettelijk <> v_neer_due or v_due <> v_neer_due or v_voorlopig is not true then
    raise exception 'FAIL 15.3: de taak van de collega werd door een vreemde AV herschreven (%, %, %)',
      v_wettelijk, v_due, v_voorlopig;
  end if;
  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_neerlegging and trigger_bron = 'av_opvolging_automatisch';
  if v_cnt <> 0 then
    raise exception 'FAIL 15.3: handmatige manipulatie staat als systeemgebeurtenis in het audittrail (% regels)', v_cnt;
  end if;
  raise notice 'PASS 15.3: een vreemde AV-afronding raakt de taak van de collega niet';

  -- 15.4 Een voorloper uit een ander klantdossier wordt bij aanmaak geweigerd.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  v_ok := false;
  begin
    -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
    perform set_config('taskflow.generating', 'on', true);
    insert into public.task_instances (
      client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
      status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring, voorloper_taak_id
    ) values (
      v_client2, v_ot_neer, '2044-cross', current_date + 40, current_date + 40,
      'open', v_mw, 'automatisch_gegenereerd', true, v_av_echt
    );
    perform set_config('taskflow.generating', 'off', true);
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 15.4: een taak kon aan de voorloper van een ander klantdossier gekoppeld worden';
  end if;
  raise notice 'PASS 15.4: voorloper-koppeling over klantgrenzen heen wordt geweigerd';

  -- 15.5 De rij-loze pijplijnvlag uit 0011 is geen hefboom meer.
  perform set_config('taskflow.pipeline', 'on', true);
  v_ok := false;
  begin
    update public.task_instances set due_date_wettelijk = date '2099-01-01' where id = v_neerlegging;
  exception when others then v_ok := true;
  end;
  perform set_config('taskflow.pipeline', 'off', true);
  if not v_ok then
    raise exception 'FAIL 15.5: de oude boolean-pijplijnvlag gaf nog steeds pijplijnrechten';
  end if;
  raise notice 'PASS 15.5: de rij-loze pijplijnvlag geeft geen rechten meer';

  -- 15.6 En de nieuwe vlag geldt alleen voor de rij die ze noemt.
  perform set_config('taskflow.pipeline_task_id', v_av_aanvaller::text, true);
  v_ok := false;
  begin
    update public.task_instances set due_date_wettelijk = date '2099-01-01' where id = v_neerlegging;
  exception when others then v_ok := true;
  end;
  perform set_config('taskflow.pipeline_task_id', '', true);
  if not v_ok then
    raise exception 'FAIL 15.6: de pijplijnvlag van rij A gaf rechten op rij B';
  end if;
  raise notice 'PASS 15.6: de pijplijnvlag is rij-gebonden';

  -- 15.7 De oude, rij-loze helper bestaat niet meer.
  set local role postgres;
  if to_regprocedure('public.taskflow_pipeline_active()') is not null then
    raise exception 'FAIL 15.7: taskflow_pipeline_active() bestaat nog als rij-loze hefboom';
  end if;
  raise notice 'PASS 15.7: taskflow_pipeline_active() is verwijderd';

  -- 15.8 De legitieme keten blijft gewoon werken (§3 punt 5).
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  update public.task_instances set status = 'wacht_op_goedkeuring' where id = v_av_echt;
  update public.task_instances set status = 'ingediend_afgerond' where id = v_av_echt;

  select afgerond_op::date into v_afgerond from public.task_instances where id = v_av_echt;
  select due_date_wettelijk, due_date, voorlopige_datum into v_wettelijk, v_due, v_voorlopig
  from public.task_instances where id = v_neerlegging;
  if v_wettelijk <> v_afgerond + 30 or v_due <> public.next_business_day(v_afgerond + 30) or v_voorlopig is not false then
    raise exception 'FAIL 15.8: de echte AV-opvolging werkt niet meer (%, %, %)', v_wettelijk, v_due, v_voorlopig;
  end if;
  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_neerlegging and trigger_bron = 'av_opvolging_automatisch';
  if v_cnt <> 1 then
    raise exception 'FAIL 15.8: de echte AV-opvolging logde % regels (verwacht 1)', v_cnt;
  end if;
  raise notice 'PASS 15.8: de echte AV -> neerlegging-keten werkt onveranderd';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 16 (B-2): vereist_goedkeuring wordt bij INSERT afgeleid uit de
-- catalogus, een nieuwe taak start altijd 'open', en aanmaak laat een
-- spoor na.
--
-- Gereproduceerd vóór 0012: annuleer de goedkeuringsplichtige taak, maak
-- een vervanger met bron_type='automatisch_gegenereerd',
-- periode_label='...-bis' en vereist_goedkeuring=false, en rond die meteen
-- af. Geen goedkeurder, en geen enkele logregel over de aanmaak.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin_uid uuid := gen_random_uuid(); v_admin uuid;
  v_mw_uid uuid := gen_random_uuid(); v_mw uuid;
  v_client uuid; v_ot uuid; v_co uuid; v_task uuid; v_vervanger uuid; v_adhoc uuid;
  v_vereist boolean; v_status public.task_status; v_gd uuid; v_ao timestamptz;
  v_cnt int; v_ok boolean; v_notitie text;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 'b2-admin@test.local', now());
  insert into auth.users (id, email, email_confirmed_at) values (v_mw_uid, 'b2-mw@test.local', now());
  insert into public.firms (naam) values ('B2 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'B2 Beheerder', 'b2-admin@test.local', 'kantoorbeheerder', true, true) returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'B2 Medewerker', 'b2-mw@test.local', 'medewerker', false, true) returning id into v_mw;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'B2 Klant', 12, 31, 'geen', false, true) returning id into v_client;
  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
    values (v_client, v_ot, true, current_date, v_mw) returning id into v_co;
  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, client_obligation_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, v_co, '2027', current_date + 60, current_date + 60,
    'open', v_mw, 'automatisch_gegenereerd', true
  ) returning id into v_task;
  perform set_config('taskflow.generating', 'off', true);

  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;

  -- 16.1 Annuleren mag (zie sectie 17), maar wordt herkenbaar gelogd.
  update public.task_instances set status = 'geannuleerd' where id = v_task;
  select notitie into v_notitie from public.task_status_log
  where task_instance_id = v_task and event_type = 'status_wijziging' and nieuw_status = 'geannuleerd'
  order by created_at desc limit 1;
  if v_notitie is null then
    raise exception 'FAIL 16.1: annuleren van een gegenereerde verplichting werd zonder toelichting gelogd';
  end if;
  raise notice 'PASS 16.1: annuleren wordt herkenbaar gelogd (%)', left(v_notitie, 50);

  -- 16.2 De vervanger krijgt zijn goedkeuringsplicht uit de catalogus, niet
  -- uit de payload — en start open, niet afgerond.
  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, client_obligation_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring,
    goedgekeurd_door, goedgekeurd_op, afgerond_op
  ) values (
    v_client, v_ot, v_co, '2027-bis', current_date + 60, current_date + 60,
    'ingediend_afgerond', v_mw, 'automatisch_gegenereerd', false,
    v_mw, now(), now()
  ) returning id into v_vervanger;
  perform set_config('taskflow.generating', 'off', true);

  select vereist_goedkeuring, status, goedgekeurd_door, afgerond_op
    into v_vereist, v_status, v_gd, v_ao
  from public.task_instances where id = v_vervanger;
  if v_vereist is not true then
    raise exception 'FAIL 16.2: vereist_goedkeuring was vrij in te vullen bij INSERT';
  end if;
  if v_status <> 'open' then
    raise exception 'FAIL 16.2: een taak kon meteen als % aangemaakt worden', v_status;
  end if;
  if v_gd is not null or v_ao is not null then
    raise exception 'FAIL 16.2: goedkeurings-/afrondingsstempels waren invulbaar bij INSERT (%, %)', v_gd, v_ao;
  end if;
  raise notice 'PASS 16.2: INSERT leidt vereist_goedkeuring af uit de catalogus en pint status/stempels';

  -- 16.3 Aanmaak laat een spoor na.
  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_vervanger and event_type = 'taak_aangemaakt' and actor_employee_id = v_mw;
  if v_cnt <> 1 then
    raise exception 'FAIL 16.3: aanmaak van een taak leverde % taak_aangemaakt-regels op (verwacht 1)', v_cnt;
  end if;
  raise notice 'PASS 16.3: aanmaak van een taak staat in het audittrail';

  -- 16.4 En de vervanger is dus even goedkeuringsplichtig als het origineel.
  v_ok := false;
  begin
    update public.task_instances set status = 'ingediend_afgerond' where id = v_vervanger;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 16.4: de vervangende taak kon zonder goedkeuring afgerond worden';
  end if;
  raise notice 'PASS 16.4: de vervanger kan de goedkeuringsstap niet overslaan';

  -- 16.5 Ad-hoc taken blijven werken (en worden ook gelogd).
  insert into public.task_instances (
    client_id, obligation_type_id, client_obligation_id, title, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, null, null, 'B2 ad-hoc taak', current_date + 3, current_date + 3,
    'open', v_mw, 'handmatig_adhoc', false
  ) returning id into v_adhoc;
  select vereist_goedkeuring into v_vereist from public.task_instances where id = v_adhoc;
  if v_vereist is not false then
    raise exception 'FAIL 16.5: een ad-hoc taak kreeg een goedkeuringsplicht';
  end if;
  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_adhoc and event_type = 'taak_aangemaakt';
  if v_cnt <> 1 then
    raise exception 'FAIL 16.5: ad-hoc aanmaak leverde % logregels op (verwacht 1)', v_cnt;
  end if;
  raise notice 'PASS 16.5: ad-hoc taken blijven goedkeuringsvrij en worden gelogd';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 17 (B-3): annuleren is geen doodlopend spoor meer.
--
-- Gereproduceerd vóór 0012: elke medewerker kon een gegenereerde wettelijke
-- taak annuleren; daarna was heropenen onmogelijk (eindstatus), hergeneratie
-- onmogelijk (de unieke index telde geannuleerde rijen mee) en verwijderen
-- onmogelijk. De verplichting was permanent uit alle werklijsten weg.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin_uid uuid := gen_random_uuid(); v_admin uuid;
  v_mw_uid uuid := gen_random_uuid(); v_mw uuid;
  v_client uuid; v_ot uuid; v_co uuid;
  v_task uuid; v_label text; v_task2 uuid; v_label2 text;
  v_cnt int; v_ok boolean; v_status public.task_status; v_notitie text;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 'b3-admin@test.local', now());
  insert into auth.users (id, email, email_confirmed_at) values (v_mw_uid, 'b3-mw@test.local', now());
  insert into public.firms (naam) values ('B3 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'B3 Beheerder', 'b3-admin@test.local', 'kantoorbeheerder', true, true) returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'B3 Medewerker', 'b3-mw@test.local', 'medewerker', false, true) returning id into v_mw;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'B3 Klant', 12, 31, 'geen', false, true) returning id into v_client;
  select id into v_ot from public.obligation_types where code = 'rapportering';
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters, standaard_toegewezen_medewerker_id)
    values (v_client, v_ot, true, current_date, jsonb_build_object('frequentie', 'maand', 'termijn_dagen', 10), v_mw)
    returning id into v_co;

  perform public.generate_task_instances(3, 6);

  select id, periode_label into v_task, v_label
  from public.task_instances where client_id = v_client and status = 'open'
  order by due_date asc limit 1;
  select id, periode_label into v_task2, v_label2
  from public.task_instances where client_id = v_client and status = 'open' and id <> v_task
  order by due_date desc limit 1;
  if v_task is null or v_task2 is null then
    raise exception 'FAIL 17.0: fixture leverde geen twee gegenereerde taken op';
  end if;
  raise notice 'PASS 17.0: fixture heeft gegenereerde taken (% en %)', v_label, v_label2;

  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;

  -- 17.1 Annuleren blijft toegelaten voor een gewone medewerker.
  update public.task_instances set status = 'geannuleerd' where id = v_task;
  select status into v_status from public.task_instances where id = v_task;
  if v_status <> 'geannuleerd' then
    raise exception 'FAIL 17.1: annuleren werkte niet (%)', v_status;
  end if;
  raise notice 'PASS 17.1: annuleren blijft dagelijks werk, geen beheerdershandeling';

  -- 17.2 De engine maakt de geannuleerde periode opnieuw aan.
  set local role postgres;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  perform public.generate_task_instances(3, 6);

  select count(*) into v_cnt from public.task_instances
  where client_id = v_client and obligation_type_id = v_ot and periode_label = v_label and status = 'open';
  if v_cnt <> 1 then
    raise exception 'FAIL 17.2: de geannuleerde periode % werd niet hergenereerd (% open rijen)', v_label, v_cnt;
  end if;
  select count(*) into v_cnt from public.task_instances
  where client_id = v_client and obligation_type_id = v_ot and periode_label = v_label;
  if v_cnt <> 2 then
    raise exception 'FAIL 17.2: verwacht 1 geannuleerde + 1 nieuwe rij voor %, gevonden %', v_label, v_cnt;
  end if;
  raise notice 'PASS 17.2: de engine herstelt een geannuleerde periode (het dossier houdt beide rijen)';

  -- 17.3 Heropenen is geen recht van elke medewerker. (Deze taak wordt pas
  -- NA de hergeneratie geannuleerd, zodat er geen tweede actieve rij voor
  -- dezelfde periode bestaat en 17.4 het zuivere correctiepad test.)
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  update public.task_instances set status = 'geannuleerd' where id = v_task2;
  v_ok := false;
  begin
    update public.task_instances set status = 'open' where id = v_task2;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 17.3: een gewone medewerker kon een geannuleerde taak heropenen';
  end if;
  raise notice 'PASS 17.3: heropenen is voorbehouden aan de kantoorbeheerder';

  -- 17.4 De kantoorbeheerder heeft wél een correctiepad, met logregel.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  update public.task_instances set status = 'open' where id = v_task2;
  select status into v_status from public.task_instances where id = v_task2;
  if v_status <> 'open' then
    raise exception 'FAIL 17.4: heropenen door de kantoorbeheerder werkte niet (%)', v_status;
  end if;
  select notitie into v_notitie from public.task_status_log
  where task_instance_id = v_task2 and event_type = 'status_wijziging'
    and oud_status = 'geannuleerd' and nieuw_status = 'open'
  order by created_at desc limit 1;
  if v_notitie is null then
    raise exception 'FAIL 17.4: heropenen werd niet als zodanig gelogd';
  end if;
  raise notice 'PASS 17.4: heropenen door de kantoorbeheerder werkt en wordt gelogd';

  -- 17.5 Maar heropenen mag nooit een duplicaat opleveren.
  v_ok := false;
  begin
    update public.task_instances set status = 'open' where id = v_task;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 17.5: heropenen naast een reeds hergenereerde taak gaf een duplicaat';
  end if;
  select count(*) into v_cnt from public.task_instances
  where client_id = v_client and obligation_type_id = v_ot and periode_label = v_label and status <> 'geannuleerd';
  if v_cnt <> 1 then
    raise exception 'FAIL 17.5: % actieve rijen voor periode % (verwacht 1)', v_cnt, v_label;
  end if;
  raise notice 'PASS 17.5: heropenen wordt geweigerd wanneer de periode al een actieve taak heeft';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 18 (B-5): kolommen die gedrag of bewijskracht bepalen zijn
-- bevroren, en inhoudelijke wijzigingen op gegenereerde taken worden
-- gelogd.
--
-- Gereproduceerd vóór 0012: als medewerker in één PATCH gewijzigd, 1 rij,
-- 0 logregels: periode_start, periode_eind, title, description,
-- voorlopige_datum, review_reden, created_at (5 jaar teruggezet) en zelfs
-- id. periode_eind is niet cosmetisch: de wettelijke-kalenderherberekening
-- matcht erop.
-- ============================================================
do $$
declare
  v_firm uuid; v_uid uuid := gen_random_uuid(); v_emp uuid;
  v_client uuid; v_ot uuid; v_task uuid; v_nieuw_id uuid := gen_random_uuid();
  v_ps date; v_pe date; v_created timestamptz; v_created_voor timestamptz;
  v_voorlopig boolean; v_title text; v_cnt int; v_notitie text; v_ok boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 'b5@test.local', now());
  insert into public.firms (naam) values ('B5 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'B5 Medewerker', 'b5@test.local', 'medewerker', false, true) returning id into v_emp;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'B5 Klant', 12, 31, 'geen', false, true) returning id into v_client;
  select id into v_ot from public.obligation_types where code = 'aangifte_venb_pb';
  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, periode_start, periode_eind,
    due_date, due_date_wettelijk, status, toegewezen_medewerker_id, bron_type,
    vereist_goedkeuring, voorlopige_datum, title, description
  ) values (
    v_client, v_ot, '2035', date '2035-01-01', date '2035-12-31',
    date '2036-09-30', date '2036-09-30', 'open', v_emp, 'automatisch_gegenereerd',
    true, true, 'Aangifte VenB 2035', 'Originele omschrijving'
  ) returning id into v_task;
  perform set_config('taskflow.generating', 'off', true);
  select created_at into v_created_voor from public.task_instances where id = v_task;

  set local role authenticated;

  -- 18.0 Eén PATCH met alles erin, precies zoals de review deed. Sinds 0013
  -- struikelt die op voorlopige_datum: dat is geen stille reset meer maar
  -- een luide weigering, en de hele PATCH gaat mee onderuit.
  v_ok := false;
  begin
    update public.task_instances
    set periode_start = date '1999-01-01',
        periode_eind = date '1999-12-31',
        created_at = now() - interval '5 years',
        voorlopige_datum = false,
        title = 'Gemanipuleerde titel',
        description = 'Gemanipuleerde omschrijving',
        review_reden = 'Verzonnen reden'
    where id = v_task;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 18.0: een medewerker kon voorlopige_datum uitzetten zonder weigering';
  end if;
  select voorlopige_datum, title into v_voorlopig, v_title
  from public.task_instances where id = v_task;
  if v_voorlopig is not true then
    raise exception 'FAIL 18.0: voorlopige_datum werd toch uitgezet';
  end if;
  if v_title <> 'Aangifte VenB 2035' then
    raise exception 'FAIL 18.0: de geweigerde PATCH liet toch een titelwijziging achter (%)', v_title;
  end if;
  raise notice 'PASS 18.0: de alles-in-één PATCH wordt luid geweigerd op voorlopige_datum';

  -- 18.1 Dezelfde PATCH zonder voorlopige_datum: de structuurvelden worden
  -- stil bevroren, de inhoudelijke velden gaan door (en worden gelogd).
  update public.task_instances
  set periode_start = date '1999-01-01',
      periode_eind = date '1999-12-31',
      created_at = now() - interval '5 years',
      title = 'Gemanipuleerde titel',
      description = 'Gemanipuleerde omschrijving',
      review_reden = 'Verzonnen reden'
  where id = v_task;

  select periode_start, periode_eind, created_at, voorlopige_datum, title
    into v_ps, v_pe, v_created, v_voorlopig, v_title
  from public.task_instances where id = v_task;

  if v_ps <> date '2035-01-01' or v_pe <> date '2035-12-31' then
    raise exception 'FAIL 18.1: periode_start/periode_eind waren wijzigbaar (%, %)', v_ps, v_pe;
  end if;
  if v_created is distinct from v_created_voor then
    raise exception 'FAIL 18.1: created_at was terug te zetten (%)', v_created;
  end if;
  if v_voorlopig is not true then
    raise exception 'FAIL 18.1: voorlopige_datum was door een medewerker te zetten';
  end if;
  raise notice 'PASS 18.1: periode_start/periode_eind/created_at zijn bevroren';

  -- 18.2 Titel/omschrijving/review_reden mogen wél wijzigen, maar nooit stil.
  if v_title <> 'Gemanipuleerde titel' then
    raise exception 'FAIL 18.2: titel werd geblokkeerd i.p.v. gelogd (%)', v_title;
  end if;
  select count(*), max(notitie) into v_cnt, v_notitie from public.task_status_log
  where task_instance_id = v_task and event_type = 'taak_inhoud_gewijzigd';
  if v_cnt <> 1 then
    raise exception 'FAIL 18.2: inhoudelijke wijziging leverde % logregels op (verwacht 1)', v_cnt;
  end if;
  if v_notitie not like '%titel%' or v_notitie not like '%omschrijving%' or v_notitie not like '%review_reden%' then
    raise exception 'FAIL 18.2: de logregel benoemt niet alle gewijzigde velden (%)', v_notitie;
  end if;
  raise notice 'PASS 18.2: title/description/review_reden-wijzigingen worden gelogd (%)', v_notitie;

  -- 18.3 De primaire sleutel is geen gewoon veld.
  update public.task_instances set id = v_nieuw_id where id = v_task;
  select count(*) into v_cnt from public.task_instances where id = v_task;
  if v_cnt <> 1 then
    raise exception 'FAIL 18.3: de id van een taak was wijzigbaar (de rij is van id veranderd)';
  end if;
  select count(*) into v_cnt from public.task_instances where id = v_nieuw_id;
  if v_cnt <> 0 then
    raise exception 'FAIL 18.3: er staat een taak onder de gemanipuleerde id';
  end if;
  raise notice 'PASS 18.3: id is bevroren';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 19 (B-6/B-7): ontbrekende revokes, begrensde feestdag-
-- herberekening en de jaar/datum-consistentie van public_holidays.
-- ============================================================
do $$
declare
  v_firm uuid; v_uid uuid := gen_random_uuid(); v_emp uuid;
  v_client uuid; v_ot uuid; v_task uuid;
  v_woensdag date := date_trunc('week', date '2033-06-08')::date + 2;
  v_due date; v_cnt int; v_ok boolean;
begin
  -- 19.1 B-6: triggerfuncties zijn niet uitvoerbaar door de app-rollen.
  if has_function_privilege('authenticated', 'public.enforce_task_assignment_firm_on_insert()', 'execute')
     or has_function_privilege('anon', 'public.enforce_task_assignment_firm_on_insert()', 'execute') then
    raise exception 'FAIL 19.1: enforce_task_assignment_firm_on_insert() is nog rechtstreeks uitvoerbaar';
  end if;
  if has_function_privilege('authenticated', 'public.recalc_due_dates_after_holiday_change()', 'execute')
     or has_function_privilege('anon', 'public.recalc_due_dates_after_holiday_change()', 'execute') then
    raise exception 'FAIL 19.1: recalc_due_dates_after_holiday_change() is nog rechtstreeks uitvoerbaar';
  end if;
  raise notice 'PASS 19.1: de triggerfuncties uit 0011 zijn niet meer rechtstreeks uitvoerbaar';

  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 'b7@test.local', now());
  insert into public.firms (naam) values ('B7 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'B7 Beheerder', 'b7@test.local', 'kantoorbeheerder', true, true) returning id into v_emp;
  perform set_config('taskflow.test_uid', v_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'B7 Klant', 12, 31, 'geen', false, true) returning id into v_client;
  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';
  -- Fixture maakt engine-output na; sinds 0013 mag alleen de engine dat.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, '2033', v_woensdag, v_woensdag, 'open', v_emp, 'automatisch_gegenereerd', true
  ) returning id into v_task;
  perform set_config('taskflow.generating', 'off', true);

  -- 19.2 B-7: jaar moet bij datum horen.
  v_ok := false;
  begin
    insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
    values (2033, date '2037-01-02', 'B7 jaar klopt niet', v_emp, v_emp);
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 19.2: een feestdag met jaar 2033 en datum in 2037 werd aanvaard';
  end if;
  raise notice 'PASS 19.2: public_holidays.jaar wordt tegen datum gecontroleerd';

  -- 19.3 De begrensde scan mag geen enkele échte verschuiving missen: een
  -- feestdag op de deadline zelf, en daarna een feestdag op de dag waar de
  -- deadline net naartoe schoof (kettingverschuiving).
  insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
  values (2033, v_woensdag, 'B7 feestdag 1', v_emp, v_emp);
  select due_date into v_due from public.task_instances where id = v_task;
  if v_due <> v_woensdag + 1 then
    raise exception 'FAIL 19.3: eerste verschuiving gemist (%)', v_due;
  end if;

  insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
  values (2033, v_woensdag + 1, 'B7 feestdag 2', v_emp, v_emp);
  select due_date into v_due from public.task_instances where id = v_task;
  if v_due <> v_woensdag + 2 then
    raise exception 'FAIL 19.3: kettingverschuiving gemist (%)', v_due;
  end if;
  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_task and event_type = 'due_date_herberekend';
  if v_cnt <> 2 then
    raise exception 'FAIL 19.3: verwacht 2 herberekeningen, gevonden %', v_cnt;
  end if;
  raise notice 'PASS 19.3: de begrensde herberekening mist geen enkele verschuiving';

  -- 19.4 En een feestdag ver buiten bereik raakt de taak niet.
  insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
  values (2033, v_woensdag + 60, 'B7 feestdag ver weg', v_emp, v_emp);
  select due_date into v_due from public.task_instances where id = v_task;
  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_task and event_type = 'due_date_herberekend';
  if v_due <> v_woensdag + 2 or v_cnt <> 2 then
    raise exception 'FAIL 19.4: een niet-relevante feestdag raakte de taak toch (%, %)', v_due, v_cnt;
  end if;
  raise notice 'PASS 19.4: feestdagen buiten bereik laten de deadline ongemoeid';
end $$;


-- ============================================================
-- Sectie 20 (0013): herkomst van gegenereerde taken (H-1), herstelbaarheid
-- van de neerleggingsdatum (H-2), bescherming van handmatige
-- deadline-afspraken (M-1) en zichtbaar maken van toegangverlening op een
-- vertrouwelijk dossier (M-3).
-- ============================================================

do $$
declare
  v_firm uuid;
  v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_mw uuid;    v_mw_uid uuid := gen_random_uuid();
  v_mw2 uuid;   v_mw2_uid uuid := gen_random_uuid();
  v_client uuid; v_vertr uuid;
  v_ot_av uuid; v_ot_neer uuid; v_ot_btw uuid;
  v_av uuid; v_av2 uuid; v_neer uuid; v_taak uuid;
  v_cnt int; v_err text; v_state text;
  v_voorlopig boolean; v_wettelijk date; v_due date; v_handmatig timestamptz;
begin
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';
  select id into v_ot_neer from public.obligation_types where code = 'neerlegging_jaarrekening';
  select id into v_ot_btw from public.obligation_types where code = 'btw_aangifte';

  insert into auth.users (id, email, email_confirmed_at) values
    (v_admin_uid, 's20-admin@test.local', now()),
    (v_mw_uid, 's20-mw@test.local', now()),
    (v_mw2_uid, 's20-mw2@test.local', now());
  insert into public.firms (naam) values ('Sectie 20 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S20 Beheerder', 's20-admin@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'S20 Medewerker', 's20-mw@test.local', 'medewerker', false, true)
    returning id into v_mw;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw2_uid, 'S20 Collega', 's20-mw2@test.local', 'medewerker', false, true)
    returning id into v_mw2;

  -- Expliciet als kantoorbeheerder: standaard_verantwoordelijke_id zetten bij
  -- aanmaak is sinds 0009 voorbehouden aan die rol. Niet op restanten uit
  -- eerdere secties leunen — sectie 20 moet los draaibaar zijn.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  insert into public.clients (
    firm_id, naam, ondernemingsnummer, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, btw_aangifte_frequentie, vertrouwelijk, standaard_verantwoordelijke_id, actief
  ) values (
    v_firm, 'S20 Klant', 'BE0000.920.001', 12, 31, 'periodieke_aangever', 'maand',
    false, v_mw, true
  ) returning id into v_client;

  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
    values (v_client, v_ot_av, true, date '2000-01-01', v_mw);

  -- ---------- H-1 ----------
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;

  -- 20.1 Een medewerker kan geen engine-output namaken: bron_type wordt naar
  -- handmatig_adhoc geduwd, en de adhoc-vormconstraint verbiedt dan een
  -- obligation_type_id. Zonder die duw kon de medewerker het periode-slot
  -- bezetten en de echte wettelijke verplichting permanent onderdrukken.
  begin
    insert into public.task_instances (
      client_id, obligation_type_id, periode_label, periode_start, periode_eind,
      due_date, due_date_wettelijk, toegewezen_medewerker_id, bron_type, title
    ) values (
      v_client, v_ot_btw, '2099-Q1', date '2099-01-01', date '2099-03-31',
      date '2099-12-31', date '2099-12-31', v_mw, 'automatisch_gegenereerd', 'nep'
    );
    raise exception 'FAIL 20.1: een medewerker kon nog steeds engine-output namaken';
  exception
    when check_violation then
      raise notice 'PASS 20.1: engine-output namaken wordt geweigerd (adhoc-vorm afgedwongen)';
    when others then
      get stacked diagnostics v_err = message_text, v_state = returned_sqlstate;
      if v_state = 'P0001' and v_err like 'FAIL 20.1%' then raise; end if;
      raise notice 'PASS 20.1: engine-output namaken wordt geweigerd (%)' , v_state;
  end;

  -- 20.2 Een echte ad-hoc taak (zonder verplichtingtype) blijft gewoon werken.
  insert into public.task_instances (
    client_id, due_date, due_date_wettelijk, toegewezen_medewerker_id, bron_type, title
  ) values (
    v_client, current_date + 5, current_date + 5, v_mw, 'handmatig_adhoc', 'S20 ad-hoc'
  ) returning id into v_taak;
  select bron_type::text into v_err from public.task_instances where id = v_taak;
  if v_err <> 'handmatig_adhoc' then
    raise exception 'FAIL 20.2: ad-hoc taak kreeg bron_type % ', v_err;
  end if;
  raise notice 'PASS 20.2: ad-hoc taken blijven normaal aanmaakbaar';

  -- 20.3 De engine mag het wel.
  set local role postgres;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  perform public.generate_task_instances(3, 6);

  select count(*) into v_cnt from public.task_instances
  where client_id = v_client and bron_type = 'automatisch_gegenereerd';
  if v_cnt = 0 then
    raise exception 'FAIL 20.3: de engine genereerde niets meer';
  end if;
  raise notice 'PASS 20.3: de engine maakt nog steeds engine-output (% rijen)', v_cnt;

  -- ---------- H-2 ----------
  select id into v_av from public.task_instances
  where client_id = v_client and obligation_type_id = v_ot_av and status = 'open' limit 1;
  select id into v_neer from public.task_instances
  where client_id = v_client and obligation_type_id = v_ot_neer limit 1;

  if v_av is null or v_neer is null then
    raise exception 'FAIL 20.4: AV/neerlegging-fixture ontbreekt (av=%, neerlegging=%)', v_av, v_neer;
  end if;

  -- 20.4 Annuleer de AV en laat de engine opnieuw lopen: de neerlegging mag
  -- niet aan de geannuleerde AV blijven hangen, anders vuurt de
  -- +30-dagenberekening nooit meer.
  update public.task_instances set status = 'geannuleerd' where id = v_av;
  perform public.generate_task_instances(3, 6);

  select id into v_av2 from public.task_instances
  where client_id = v_client and obligation_type_id = v_ot_av and status = 'open' limit 1;
  if v_av2 is null or v_av2 = v_av then
    raise exception 'FAIL 20.4: de engine maakte geen nieuwe AV aan na annulering';
  end if;

  select voorloper_taak_id into v_taak from public.task_instances where id = v_neer;
  if v_taak is distinct from v_av2 then
    raise exception 'FAIL 20.4: de neerlegging hangt nog aan de geannuleerde AV (% i.p.v. %)', v_taak, v_av2;
  end if;
  raise notice 'PASS 20.4: de engine herkoppelt de neerlegging aan de nieuwe AV';

  -- 20.5 En de definitieve datum komt er nu wel degelijk.
  update public.task_instances set status = 'in_uitvoering' where id = v_av2;
  update public.task_instances set status = 'wacht_op_goedkeuring' where id = v_av2;
  update public.task_instances set status = 'ingediend_afgerond' where id = v_av2;

  select voorlopige_datum, due_date_wettelijk into v_voorlopig, v_wettelijk
  from public.task_instances where id = v_neer;
  if v_voorlopig then
    raise exception 'FAIL 20.5: de neerlegging staat nog altijd op een voorlopige datum';
  end if;
  if v_wettelijk <> current_date + 30 then
    raise exception 'FAIL 20.5: neerleggingsdatum % i.p.v. %', v_wettelijk, current_date + 30;
  end if;
  raise notice 'PASS 20.5: afronden van de nieuwe AV levert een definitieve neerleggingsdatum';

  -- 20.6 Het handmatig herkoppelen van een voorloper weigert nu luidruchtig
  -- i.p.v. stil terug te zetten (een stille 200 was misleidend).
  begin
    update public.task_instances set voorloper_taak_id = v_av where id = v_neer;
    raise exception 'FAIL 20.6: voorloper_taak_id was handmatig te wijzigen';
  exception
    when insufficient_privilege then
      raise notice 'PASS 20.6: handmatig herkoppelen van een voorloper wordt geweigerd';
    when others then
      get stacked diagnostics v_err = message_text, v_state = returned_sqlstate;
      if v_state = 'P0001' and v_err like 'FAIL 20.6%' then raise; end if;
      raise;
  end;

  -- 20.7 Een blijven-hangen "voorlopige" markering is door een
  -- kantoorbeheerder recht te zetten, en door een medewerker niet.
  set local role postgres;
  -- De markering terugzetten is een pijplijnhandeling; alleen zo kan de
  -- fixture de "blijven hangen"-situatie nabootsen.
  perform set_config('taskflow.pipeline_task_id', v_neer::text, true);
  update public.task_instances set voorlopige_datum = true where id = v_neer;
  perform set_config('taskflow.pipeline_task_id', '', true);
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  begin
    update public.task_instances set voorlopige_datum = false where id = v_neer;
    raise exception 'FAIL 20.7: een gewone medewerker kon de datum definitief verklaren';
  exception
    when insufficient_privilege then
      raise notice 'PASS 20.7a: een medewerker kan de voorlopige markering niet zelf wegnemen';
    when others then
      get stacked diagnostics v_err = message_text, v_state = returned_sqlstate;
      if v_state = 'P0001' and v_err like 'FAIL 20.7%' then raise; end if;
      raise;
  end;

  set local role postgres;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  update public.task_instances set voorlopige_datum = false where id = v_neer;
  select voorlopige_datum into v_voorlopig from public.task_instances where id = v_neer;
  if v_voorlopig then
    raise exception 'FAIL 20.7: de kantoorbeheerder kon de datum niet definitief verklaren';
  end if;
  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_neer and event_type = 'taak_inhoud_gewijzigd'
    and notitie like '%definitief%';
  if v_cnt < 1 then
    raise exception 'FAIL 20.7: het definitief verklaren werd niet gelogd';
  end if;
  raise notice 'PASS 20.7b: een kantoorbeheerder kan de datum definitief verklaren, en dat wordt gelogd';

  -- ---------- M-1 ----------
  -- 20.8 Een handmatig afgesproken deadline wordt niet meer stil
  -- overschreven door een nieuwe feestdag; de taak wordt gemarkeerd voor
  -- review zodat het kantoor zelf beslist.
  select id, due_date_wettelijk into v_taak, v_wettelijk from public.task_instances
  where client_id = v_client and obligation_type_id = v_ot_btw and status = 'open'
    and due_date_wettelijk > current_date
  order by due_date_wettelijk limit 1;

  if v_taak is null then
    raise exception 'FAIL 20.8: geen open BTW-taak met een toekomstige deadline gevonden';
  end if;

  update public.task_instances set due_date = v_wettelijk + 30 where id = v_taak;
  select due_date_handmatig_op, due_date into v_handmatig, v_due
  from public.task_instances where id = v_taak;
  if v_handmatig is null then
    raise exception 'FAIL 20.8: een handmatige deadline-wijziging werd niet gemarkeerd';
  end if;

  -- Feestdag exact op de wettelijke datum: zonder de M-1-fix zou due_date
  -- terugspringen naar de eerstvolgende werkdag en de afspraak verdwijnen.
  insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
  values (extract(year from v_wettelijk)::int, v_wettelijk, 'S20 testfeestdag', v_admin, v_admin);

  select due_date, review_vereist into v_due, v_voorlopig from public.task_instances where id = v_taak;
  if v_due <> v_wettelijk + 30 then
    raise exception 'FAIL 20.8: de handmatige afspraak werd overschreven (% i.p.v. %)', v_due, v_wettelijk + 30;
  end if;
  if not v_voorlopig then
    raise exception 'FAIL 20.8: de taak werd niet gemarkeerd voor review na de kalenderwijziging';
  end if;
  raise notice 'PASS 20.8: een handmatige deadline blijft staan en wordt gemarkeerd voor review';

  -- ---------- M-3 ----------
  -- 20.9 Toewijzing op een vertrouwelijke klant is een toegangsbeslissing en
  -- hoort herkenbaar in het log, niet verstopt als gewone herverdeling.
  set local role postgres;
  insert into public.clients (
    firm_id, naam, ondernemingsnummer, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, vertrouwelijk, standaard_verantwoordelijke_id, actief
  ) values (
    v_firm, 'S20 Vertrouwelijk', 'BE0000.920.002', 12, 31, 'geen', true, v_mw, true
  ) returning id into v_vertr;
  insert into public.task_instances (
    client_id, due_date, due_date_wettelijk, toegewezen_medewerker_id, bron_type, title
  ) values (
    v_vertr, current_date + 10, current_date + 10, v_mw, 'handmatig_adhoc', 'S20 vertrouwelijke taak'
  ) returning id into v_taak;

  -- Sinds 0014 (bevinding C) is toegang verlenen tot een vertrouwelijk
  -- dossier een kantoorbeheerdersbeslissing; sectie 21.5 bewaakt de weigering
  -- voor een gewone medewerker. Hier gaat het om het audittrail van de
  -- toegestane route.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;

  if public.can_view_client(v_vertr, v_mw2) then
    raise exception 'FAIL 20.9: de collega zag het vertrouwelijke dossier al voor de toewijzing';
  end if;

  update public.task_instances set toegewezen_medewerker_id = v_mw2 where id = v_taak;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then
    raise exception 'FAIL 20.9: de toewijzing zelf ging niet door (% rijen)', v_cnt;
  end if;

  -- Het audittrail nakijken gebeurt buiten RLS: door de toewijzing is het
  -- dossier voor de toewijzer zelf niet langer zichtbaar, dus onder RLS zou
  -- de assertie leeg lijken terwijl het log wel degelijk geschreven is.
  set local role postgres;
  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_taak and event_type = 'taak_inhoud_gewijzigd'
    and notitie like 'Toegang tot vertrouwelijk dossier verleend%';
  if v_cnt <> 1 then
    raise exception 'FAIL 20.9: toegangverlening niet herkenbaar gelogd (%)', v_cnt;
  end if;

  select count(*) into v_cnt from public.client_change_log
  where client_id = v_vertr and veld = 'toegang_vertrouwelijk_verleend';
  if v_cnt <> 1 then
    raise exception 'FAIL 20.9: toegangverlening niet in client_change_log (%)', v_cnt;
  end if;
  raise notice 'PASS 20.9: toegang verlenen tot een vertrouwelijk dossier is herkenbaar geaudit';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 21 (0014): single-tenant-slot (A), bevriezing van
-- due_date_handmatig_op (B), autorisatie van toegangverlening op een
-- vertrouwelijk dossier (C), bevriezing + audit van employees (D), de
-- review_reden-tekstbug (F), de dode kanban-tabellen (H) en het spoor van
-- de voorloper-herkoppeling (J).
-- ============================================================
do $$
declare
  v_firm uuid; v_firm2 uuid;
  v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_mw uuid;    v_mw_uid uuid := gen_random_uuid();
  v_mw2 uuid;   v_mw2_uid uuid := gen_random_uuid();
  v_vreemde_uid uuid := gen_random_uuid();
  v_admin2 uuid; v_admin2_uid uuid := gen_random_uuid();
  v_client uuid; v_client2 uuid; v_vertr uuid;
  v_ot uuid; v_taak uuid; v_taak2 uuid;
  v_due date; v_wettelijk date; v_handmatig timestamptz;
  v_cnt int; v_ok boolean; v_reden text; v_uid uuid;
begin
  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';

  insert into auth.users (id, email, email_confirmed_at) values
    (v_admin_uid, 's21-admin@test.local', now()),
    (v_mw_uid, 's21-mw@test.local', now()),
    (v_mw2_uid, 's21-mw2@test.local', now()),
    (v_vreemde_uid, 's21-vreemde@test.local', now()),
    (v_admin2_uid, 's21-admin2@test.local', now());

  insert into public.firms (naam) values ('Sectie 21 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S21 Beheerder', 's21-admin@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'S21 Medewerker', 's21-mw@test.local', 'medewerker', false, true)
    returning id into v_mw;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw2_uid, 'S21 Collega', 's21-mw2@test.local', 'medewerker', false, true)
    returning id into v_mw2;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'S21 Klant', 12, 31, 'geen', false, true) returning id into v_client;

  -- ---------- A ----------
  -- 21.1 De publieke onboarding-RPC weigert een tweede kantoor. Vóór 0014
  -- werd een wildvreemde hiermee kantoorbeheerder van een eigen "kantoor" en
  -- kreeg daarmee schrijfrecht op de GEDEELDE wettelijke kalender.
  perform set_config('taskflow.test_uid', v_vreemde_uid::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    perform public.create_firm_and_admin('Aanvaller BV', 'Mallory');
  exception when insufficient_privilege then v_ok := true;
  end;
  set local role postgres;
  if not v_ok then
    raise exception 'FAIL 21.1: een buitenstaander kon een tweede kantoor aanmaken';
  end if;
  if exists (select 1 from public.employees where auth_user_id = v_vreemde_uid) then
    raise exception 'FAIL 21.1: de buitenstaander kreeg toch een medewerkersprofiel';
  end if;
  raise notice 'PASS 21.1: het single-tenant-slot weigert een tweede kantoor';

  -- 21.2 Diepteverdediging: bestaat er tóch een tweede kantoor (bewust
  -- aangemaakt), dan raakt zijn feestdag de deadlines van kantoor 1 niet.
  insert into public.firms (naam) values ('S21 Tweede kantoor') returning id into v_firm2;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm2, v_admin2_uid, 'S21 Beheerder 2', 's21-admin2@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin2;
  perform set_config('taskflow.test_uid', v_admin2_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm2, 'S21 Klant kantoor 2', 12, 31, 'geen', false, true) returning id into v_client2;

  -- Een taak in elk kantoor, met dezelfde (werkdag-)deadline.
  v_due := date_trunc('week', date '2038-03-08')::date + 2;  -- woensdag
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (v_client, v_ot, '2038', v_due, v_due, 'open', v_admin, 'automatisch_gegenereerd', true)
  returning id into v_taak;
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (v_client2, v_ot, '2038', v_due, v_due, 'open', v_admin2, 'automatisch_gegenereerd', true)
  returning id into v_taak2;
  perform set_config('taskflow.generating', 'off', true);

  -- Beheerder van kantoor 2 voert een feestdag in op die datum.
  insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
  values (2038, v_due, 'S21 feestdag kantoor 2', v_admin2, v_admin2);

  select due_date into v_due from public.task_instances where id = v_taak2;
  if v_due <> date_trunc('week', date '2038-03-08')::date + 3 then
    raise exception 'FAIL 21.2: de eigen taak van kantoor 2 verschoof niet (%)', v_due;
  end if;
  select due_date into v_due from public.task_instances where id = v_taak;
  if v_due <> date_trunc('week', date '2038-03-08')::date + 2 then
    raise exception 'FAIL 21.2: de feestdag van kantoor 2 verzette de deadline van kantoor 1 (%)', v_due;
  end if;
  raise notice 'PASS 21.2: een feestdag van een ander kantoor raakt onze deadlines niet';

  -- ---------- B ----------
  -- 21.3 De markering wissen kan niet meer. Vóór 0014 werd de handmatige
  -- afspraak daarna alsnog stil overschreven door de kalenderpijplijn.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  update public.task_instances set toegewezen_medewerker_id = v_mw where id = v_taak;
  update public.task_instances set due_date = due_date + 14 where id = v_taak;
  select due_date_handmatig_op into v_handmatig from public.task_instances where id = v_taak;
  if v_handmatig is null then
    raise exception 'FAIL 21.3: een handmatige deadline werd niet gemarkeerd';
  end if;

  update public.task_instances set due_date_handmatig_op = null where id = v_taak;
  select due_date_handmatig_op into v_handmatig from public.task_instances where id = v_taak;
  if v_handmatig is null then
    raise exception 'FAIL 21.3: de markering was te wissen door een medewerker';
  end if;
  raise notice 'PASS 21.3: due_date_handmatig_op is niet te wissen';

  -- 21.4 En ook niet te zetten zonder de due_date aan te raken — anders maak
  -- je een taak immuun voor de kalenderpijplijn en zet je een wettelijke
  -- deadline vast op een feestdag.
  -- Een verse taak van het eigen kantoor: v_taak2 hoort bij kantoor 2 en zou
  -- al op de kantoorgrens stranden, waardoor deze assertie niets zou bewijzen.
  set local role postgres;
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, '2039', date '2039-06-30', date '2039-06-30',
    'open', v_mw, 'automatisch_gegenereerd', true
  ) returning id into v_taak2;
  perform set_config('taskflow.generating', 'off', true);
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;

  update public.task_instances set due_date_handmatig_op = now() where id = v_taak2;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then
    raise exception 'FAIL 21.4: de update raakte geen rij (%), de assertie bewijst dan niets', v_cnt;
  end if;
  select due_date_handmatig_op into v_handmatig from public.task_instances where id = v_taak2;
  if v_handmatig is not null then
    raise exception 'FAIL 21.4: de markering was te zetten zonder de deadline te wijzigen';
  end if;
  raise notice 'PASS 21.4: due_date_handmatig_op is niet los te zetten';

  -- ---------- C ----------
  -- 21.5 Een gewone medewerker kan geen toegang tot een vertrouwelijk dossier
  -- weggeven; een kantoorbeheerder wel, en dat wordt geaudit.
  set local role postgres;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (
    firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime,
    vertrouwelijk, standaard_verantwoordelijke_id, actief
  ) values (v_firm, 'S21 Vertrouwelijk', 12, 31, 'geen', true, v_mw, true)
  returning id into v_vertr;
  insert into public.task_instances (
    client_id, due_date, due_date_wettelijk, toegewezen_medewerker_id, bron_type, title
  ) values (v_vertr, current_date + 10, current_date + 10, v_mw, 'handmatig_adhoc', 'S21 vertrouwelijke taak')
  returning id into v_taak;

  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    update public.task_instances set toegewezen_medewerker_id = v_mw2 where id = v_taak;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 21.5: een medewerker kon toegang tot een vertrouwelijk dossier weggeven';
  end if;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  update public.task_instances set toegewezen_medewerker_id = v_mw2 where id = v_taak;
  set local role postgres;
  select count(*) into v_cnt from public.client_change_log
  where client_id = v_vertr and veld = 'toegang_vertrouwelijk_verleend';
  if v_cnt <> 1 then
    raise exception 'FAIL 21.5: de kantoorbeheerder-route werd niet geaudit (%)', v_cnt;
  end if;
  raise notice 'PASS 21.5: enkel een kantoorbeheerder kan toegang tot een vertrouwelijk dossier verlenen';

  -- ---------- D ----------
  -- 21.6 Identiteitskolommen van een medewerker liggen vast, ook voor een
  -- kantoorbeheerder. Vóór 0014 sloot één PATCH een collega buiten of nam via
  -- een gewijzigd e-mailadres + claim_invite() diens identiteit over.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;

  v_ok := false;
  begin
    update public.employees set auth_user_id = null where id = v_mw2;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 21.6: auth_user_id was te ontkoppelen';
  end if;

  v_ok := false;
  begin
    update public.employees set email = 'aanvaller@elders.be' where id = v_mw2;
  exception when insufficient_privilege then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 21.6: het e-mailadres van een gekoppelde medewerker was te wijzigen';
  end if;

  v_ok := false;
  begin
    update public.employees set firm_id = v_firm2 where id = v_mw2;
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 21.6: firm_id was te wijzigen';
  end if;

  set local role postgres;
  select auth_user_id, email into v_uid, v_reden from public.employees where id = v_mw2;
  if v_uid is distinct from v_mw2_uid or v_reden <> 's21-mw2@test.local' then
    raise exception 'FAIL 21.6: de identiteit van de collega is toch gewijzigd (%, %)', v_uid, v_reden;
  end if;
  raise notice 'PASS 21.6: auth_user_id, email en firm_id van een gekoppelde medewerker liggen vast';

  -- 21.6b Een openstaande uitnodiging blijft wel corrigeerbaar.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  perform public.invite_employee('S21 Uitgenodigd', 's21-typfout@test.local', 'medewerker'::public.employee_rol, false);
  update public.employees set email = 's21-correct@test.local'
  where firm_id = v_firm and email = 's21-typfout@test.local';
  set local role postgres;
  if not exists (select 1 from public.employees where email = 's21-correct@test.local') then
    raise exception 'FAIL 21.6b: een typfout in een openstaande uitnodiging was niet te corrigeren';
  end if;
  raise notice 'PASS 21.6b: een openstaande uitnodiging blijft corrigeerbaar';

  -- 21.7 Rol, goedkeuringsrecht en actief blijven wijzigbaar, maar niet meer
  -- stilzwijgend: vóór 0014 bestond er geen enkel audittrail op employees.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  update public.employees set mag_goedkeuren = true, rol = 'kantoorbeheerder' where id = v_mw2;
  set local role postgres;
  select count(*) into v_cnt from public.employee_change_log
  where employee_id = v_mw2 and veld in ('rol', 'mag_goedkeuren');
  if v_cnt <> 2 then
    raise exception 'FAIL 21.7: rol/goedkeuringsrecht werden niet geaudit (% regels)', v_cnt;
  end if;
  select actor_employee_id into v_uid from public.employee_change_log
  where employee_id = v_mw2 and veld = 'rol' limit 1;
  if v_uid is distinct from v_admin then
    raise exception 'FAIL 21.7: de actor staat niet in het audittrail (%)', v_uid;
  end if;
  raise notice 'PASS 21.7: rol/goedkeuringsrecht/actief staan in employee_change_log';

  -- 21.8 Het audittrail van medewerkers is niet manipuleerbaar.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  delete from public.employee_change_log where employee_id = v_mw2;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then
    raise exception 'FAIL 21.8: employee_change_log-regels waren te verwijderen (%)', v_cnt;
  end if;
  update public.employee_change_log set nieuwe_waarde = 'medewerker' where employee_id = v_mw2;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then
    raise exception 'FAIL 21.8: employee_change_log-regels waren te wijzigen (%)', v_cnt;
  end if;
  raise notice 'PASS 21.8: employee_change_log is append-only';

  -- ---------- H ----------
  -- 21.9 De dode kanban-tabellen zijn niet meer bereikbaar via PostgREST.
  set local role postgres;
  if has_table_privilege('authenticated', 'public.tasks', 'insert')
     or has_table_privilege('authenticated', 'public.boards', 'insert')
     or has_table_privilege('anon', 'public.tasks', 'select') then
    raise exception 'FAIL 21.9: de dode kanban-tabellen zijn nog schrijf-/leesbaar';
  end if;
  raise notice 'PASS 21.9: de dode kanban-tabellen zijn afgesloten';

  raise notice 'PASS 21: sectie 21 volledig';
end $$;

-- ============================================================
-- Sectie 22 (0014): de review_reden-tekstbug (F) en het spoor van de
-- voorloper-herkoppeling (J). Aparte sectie: deze hebben een eigen fixture
-- met een override-kalenderrij en een AV-keten nodig.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_client uuid; v_ot uuid; v_ot_av uuid; v_ot_neer uuid;
  v_taak uuid; v_av uuid; v_neer uuid; v_av2 uuid;
  v_reden text; v_cnt int; v_due date; v_review boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 's22@test.local', now());
  insert into public.firms (naam) values ('Sectie 22 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S22 Beheerder', 's22@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'S22 Klant', 12, 31, 'geen', false, true) returning id into v_client;

  select id into v_ot from public.obligation_types where code = 'aangifte_venb_pb';
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';
  select id into v_ot_neer from public.obligation_types where code = 'neerlegging_jaarrekening';

  -- ---------- F ----------
  -- 22.1 Een taak met een handmatig afgesproken deadline én een bestaande
  -- reviewreden. Vóór 0014 kreeg review_reden letterlijk 'false' als
  -- voorvoegsel en werd de bestaande reden weggegooid.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, periode_start, periode_eind,
    due_date, due_date_wettelijk, status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, '2039', date '2039-01-01', date '2039-12-31',
    date '2040-09-28', date '2040-09-28', 'open', v_admin, 'automatisch_gegenereerd', true
  ) returning id into v_taak;
  perform set_config('taskflow.generating', 'off', true);

  set local role authenticated;
  update public.task_instances set due_date = date '2040-10-31' where id = v_taak;
  update public.task_instances set review_vereist = true, review_reden = 'Wacht op stukken van de klant'
  where id = v_taak;
  set local role postgres;

  insert into public.legal_calendar (obligation_type_id, jaar, scope, deadline_datum, is_override, aangemaakt_door, gewijzigd_door)
  values (v_ot, 2040, null, date '2040-10-15', true, v_admin, v_admin);

  select review_reden into v_reden from public.task_instances where id = v_taak;
  if v_reden like 'false%' then
    raise exception 'FAIL 22.1: review_reden begint nog met de tekst "false" (%)', v_reden;
  end if;
  if v_reden not like 'Wacht op stukken van de klant%' then
    raise exception 'FAIL 22.1: de bestaande reviewreden werd weggegooid (%)', v_reden;
  end if;
  if v_reden not like '%campagnedatum%' then
    raise exception 'FAIL 22.1: de nieuwe reden werd niet toegevoegd (%)', v_reden;
  end if;
  select due_date into v_due from public.task_instances where id = v_taak;
  if v_due <> date '2040-10-31' then
    raise exception 'FAIL 22.1: de handmatige afspraak werd overschreven (%)', v_due;
  end if;
  raise notice 'PASS 22.1: review_reden bewaart de oude reden en krijgt geen "false"-voorvoegsel (%)', left(v_reden, 60);

  -- 22.1b Dezelfde correctie op een taak zónder openstaande review. Dit is de
  -- tak die vóór 0014 letterlijk 'false' vooraan zette: nullif(false, 'true')
  -- levert de string 'false' i.p.v. null.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, periode_start, periode_eind,
    due_date, due_date_wettelijk, status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, '2041', date '2041-01-01', date '2041-12-31',
    date '2042-09-30', date '2042-09-30', 'open', v_admin, 'automatisch_gegenereerd', true
  ) returning id into v_taak;
  perform set_config('taskflow.generating', 'off', true);

  set local role authenticated;
  update public.task_instances set due_date = date '2042-11-28' where id = v_taak;
  set local role postgres;

  insert into public.legal_calendar (obligation_type_id, jaar, scope, deadline_datum, is_override, aangemaakt_door, gewijzigd_door)
  values (v_ot, 2042, null, date '2042-10-15', true, v_admin, v_admin);

  select review_reden, review_vereist into v_reden, v_review from public.task_instances where id = v_taak;
  if not v_review then
    raise exception 'FAIL 22.1b: de taak werd niet gemarkeerd voor review';
  end if;
  if v_reden like 'false%' then
    raise exception 'FAIL 22.1b: review_reden begint met de letterlijke tekst "false" (%)', v_reden;
  end if;
  if v_reden not like 'De wettelijke campagnedatum%' then
    raise exception 'FAIL 22.1b: onverwachte reviewreden (%)', v_reden;
  end if;
  raise notice 'PASS 22.1b: zonder openstaande review begint de reden gewoon bij de tekst zelf';

  -- ---------- J ----------
  -- 22.2 De engine herkoppelt een verweesde voorloper (0013, H-2) en laat daar
  -- sinds 0014 een spoor van na — de neerleggingsdeadline hangt eraan.
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
    values (v_client, v_ot_av, true, date '2000-01-01', v_admin),
           (v_client, v_ot_neer, true, date '2000-01-01', v_admin);

  perform public.generate_task_instances(24, 12);

  select id into v_av from public.task_instances
  where client_id = v_client and obligation_type_id = v_ot_av and status <> 'geannuleerd'
  order by due_date limit 1;
  select id into v_neer from public.task_instances
  where client_id = v_client and obligation_type_id = v_ot_neer and voorloper_taak_id = v_av
  limit 1;
  if v_av is null or v_neer is null then
    raise exception 'FAIL 22.2: fixture leverde geen AV -> neerlegging-keten';
  end if;

  set local role authenticated;
  update public.task_instances set status = 'geannuleerd' where id = v_av;
  set local role postgres;

  perform public.generate_task_instances(24, 12);

  select voorloper_taak_id into v_av2 from public.task_instances where id = v_neer;
  if v_av2 is null or v_av2 = v_av then
    raise exception 'FAIL 22.2: de neerlegging werd niet herkoppeld (%)', v_av2;
  end if;

  select count(*) into v_cnt from public.task_status_log
  where task_instance_id = v_neer
    and trigger_bron = 'av_opvolging_automatisch'
    and notitie like 'Voorloper hergekoppeld%';
  if v_cnt < 1 then
    raise exception 'FAIL 22.2: de herkoppeling liet geen spoor na in het audittrail';
  end if;
  raise notice 'PASS 22.2: de voorloper-herkoppeling staat in het audittrail';
end $$;

-- ============================================================
-- Sectie 23 (0015): toegang tot een vertrouwelijk dossier is ook via de
-- verplichting een kantoorbeheerdersbeslissing.
--
-- Gereproduceerd vóór 0015: een medewerker met toegang tot het dossier zette
-- de standaard-toegewezene van de verplichting op een collega, raakte zelf
-- geen enkele taak aan (dus de controle uit 0014 vuurde niet), en de
-- eerstvolgende generatieronde van de kantoorbeheerder maakte 2 taken op naam
-- van die collega. can_view_client() verleent toegang zodra iemand één
-- niet-geannuleerde taak op het dossier heeft: de collega zat binnen, zonder
-- één auditregel.
-- ============================================================
do $$
declare
  v_firm uuid;
  v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_mw uuid;    v_mw_uid uuid := gen_random_uuid();
  v_mw2 uuid;   v_mw2_uid uuid := gen_random_uuid();
  v_vertr uuid; v_gewoon uuid; v_ot uuid; v_co uuid;
  v_cnt int; v_ok boolean; v_wie uuid;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_admin_uid, 's23-admin@test.local', now()),
    (v_mw_uid, 's23-mw@test.local', now()),
    (v_mw2_uid, 's23-mw2@test.local', now());
  insert into public.firms (naam) values ('Sectie 23 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S23 Beheerder', 's23-admin@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'S23 Medewerker', 's23-mw@test.local', 'medewerker', false, true)
    returning id into v_mw;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw2_uid, 'S23 Collega', 's23-mw2@test.local', 'medewerker', false, true)
    returning id into v_mw2;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (
    firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime,
    vertrouwelijk, standaard_verantwoordelijke_id, actief
  ) values (v_firm, 'S23 Vertrouwelijk', 12, 31, 'geen', true, v_mw, true)
  returning id into v_vertr;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, vertrouwelijk, actief)
    values (v_firm, 'S23 Gewoon', 12, 31, 'geen', false, true) returning id into v_gewoon;

  select id into v_ot from public.obligation_types where code = 'algemene_vergadering';
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
    values (v_vertr, v_ot, true, date '2000-01-01', v_mw) returning id into v_co;

  -- De medewerker krijgt echte taken op het dossier en dus toegang.
  perform public.generate_task_instances(24, 12);
  if not public.can_view_client(v_vertr, v_mw) then
    raise exception 'FAIL 23.0: fixture gaf de medewerker geen toegang tot het vertrouwelijke dossier';
  end if;
  if public.can_view_client(v_vertr, v_mw2) then
    raise exception 'FAIL 23.0: de collega had al toegang voor de aanval';
  end if;
  raise notice 'PASS 23.0: fixture staat klaar (medewerker binnen, collega buiten)';

  -- 23.1 De aanval: de verplichting omzetten naar de collega.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    update public.client_obligations set standaard_toegewezen_medewerker_id = v_mw2 where id = v_co;
  exception when insufficient_privilege then v_ok := true;
  end;
  set local role postgres;
  if not v_ok then
    raise exception 'FAIL 23.1: een medewerker kon de verplichting op een collega zonder toegang zetten';
  end if;

  -- En de generatieronde van de kantoorbeheerder mag de collega dus ook niet
  -- alsnog binnenlaten.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  perform public.generate_task_instances(36, 12);
  select count(*) into v_cnt from public.task_instances
  where client_id = v_vertr and toegewezen_medewerker_id = v_mw2 and status <> 'geannuleerd';
  if v_cnt <> 0 then
    raise exception 'FAIL 23.1: de generator maakte alsnog % taken op naam van de collega', v_cnt;
  end if;
  if public.can_view_client(v_vertr, v_mw2) then
    raise exception 'FAIL 23.1: de collega ziet het vertrouwelijke dossier na de generatieronde';
  end if;
  raise notice 'PASS 23.1: de verplichtingsroute naar een vertrouwelijk dossier is dicht';

  -- 23.2 Gewone werkverdeling blijft gewoon werken: op een niet-vertrouwelijke
  -- klant mag een medewerker de verplichting toewijzen aan wie hij wil.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
    values (v_gewoon, v_ot, true, date '2000-01-01', v_mw2);
  get diagnostics v_cnt = row_count;
  set local role postgres;
  if v_cnt <> 1 then
    raise exception 'FAIL 23.2: toewijzen op een gewone klant werd geblokkeerd';
  end if;
  raise notice 'PASS 23.2: op een niet-vertrouwelijke klant blijft toewijzen vrij';

  -- 23.3 De kantoorbeheerder mag het wél, en dat komt in het audittrail — op
  -- dezelfde plek als de toewijzingsroute uit 0014.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  update public.client_obligations set standaard_toegewezen_medewerker_id = v_mw2 where id = v_co;
  set local role postgres;
  select standaard_toegewezen_medewerker_id into v_wie from public.client_obligations where id = v_co;
  if v_wie is distinct from v_mw2 then
    raise exception 'FAIL 23.3: de kantoorbeheerder kon de verplichting niet omzetten (%)', v_wie;
  end if;
  -- Op de naam van de collega, specifiek. (Het aanmaken van de verplichting in
  -- de fixture leverde al een eerste regel op: ook toen kon de aangewezen
  -- medewerker het dossier nog niet zien, dus ook dat wás een toegangsbeslissing.)
  select count(*) into v_cnt from public.client_change_log
  where client_id = v_vertr and veld = 'toegang_vertrouwelijk_verleend'
    and nieuwe_waarde = v_mw2::text;
  if v_cnt <> 1 then
    raise exception 'FAIL 23.3: de toegangverlening via de verplichting werd niet geaudit (%)', v_cnt;
  end if;
  raise notice 'PASS 23.3: de kantoorbeheerder-route werkt en wordt geaudit';

  -- 23.4 Herverdelen naar iemand die het dossier al kan zien blijft dagelijks
  -- werk, ook voor een gewone medewerker.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  update public.client_obligations set standaard_toegewezen_medewerker_id = v_mw where id = v_co;
  get diagnostics v_cnt = row_count;
  set local role postgres;
  if v_cnt <> 1 then
    raise exception 'FAIL 23.4: terugzetten naar iemand mét toegang werd geblokkeerd';
  end if;
  raise notice 'PASS 23.4: toewijzen aan wie het dossier al ziet blijft vrij';
end $$;

-- ============================================================
-- Sectie 24 (0016): grenzen op het generatievenster.
--
-- Vóór 0016 waren p_horizon_months en p_backfill_months onbegrensd. Geen
-- aanvalsroute (alleen een kantoorbeheerder start de generatie), maar wel een
-- typfout met onomkeerbare gevolgen: geen enkele domeintabel heeft een
-- DELETE-policy, dus gegenereerde taken zijn alleen te annuleren. Eén klant
-- met maandelijkse btw leverde bij horizon 120 honderdzeventien taken extra
-- op; bij ~100 dossiers zijn dat duizenden onverwijderbare rijen.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_uid uuid := gen_random_uuid();
  v_n int; v_ok boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's24@test.local', now());
  insert into public.firms (naam) values ('Sectie 24 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S24 Beheerder', 's24@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_uid::text, true);
  insert into public.clients (
    firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, btw_aangifte_frequentie, actief
  ) values (v_firm, 'S24 Klant', 12, 31, 'periodieke_aangever', 'maand', true);

  -- 24.1 Op de grens werkt het gewoon.
  v_n := public.generate_task_instances(36, 24);
  if v_n <= 0 then
    raise exception 'FAIL 24.1: generatie op de grens (36/24) leverde niets op (%)', v_n;
  end if;
  raise notice 'PASS 24.1: 36 vooruit / 24 terug werkt (% taken)', v_n;

  -- 24.2 Eén maand te ver vooruit wordt geweigerd.
  v_ok := false;
  begin
    perform public.generate_task_instances(37, 24);
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 24.2: horizon 37 werd aanvaard';
  end if;

  -- 24.3 Eén maand te ver terug ook.
  v_ok := false;
  begin
    perform public.generate_task_instances(36, 25);
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 24.3: inhaalvenster 25 werd aanvaard';
  end if;

  -- 24.4 En de typfout waar het om begonnen was.
  v_ok := false;
  begin
    perform public.generate_task_instances(120, 6);
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 24.4: horizon 120 werd aanvaard';
  end if;
  raise notice 'PASS 24.2-24.4: 37 vooruit, 25 terug en 120 worden geweigerd';

  -- 24.5 Negatieve waarden leverden voorheen stil nul taken op; nu weigeren
  -- ze, zodat verkeerde invoer altijd zichtbaar is.
  v_ok := false;
  begin
    perform public.generate_task_instances(-12, -6);
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 24.5: een negatief venster werd stil aanvaard';
  end if;
  raise notice 'PASS 24.5: een negatief venster wordt geweigerd i.p.v. stil genegeerd';

  -- 24.6 De standaardwaarden van de app blijven binnen de grenzen.
  perform public.generate_task_instances(3, 6);
  raise notice 'PASS 24.6: de standaardaanroep van de app (3/6) blijft toegelaten';
end $$;

select '=== ALL RECURRENCE ENGINE TESTS PASSED ===' as result;
