-- Taskflow v1 — recurrence-engine regression tests (docs/PLAN.md §3).
--
-- Run via ./run_recurrence_tests.sh (see README note at the bottom of this
-- file, and the developer-agent summary). This script assumes it is being
-- run against a fresh database that already has 0001-0008 applied plus the
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
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_vertrouwelijk_id,
    (select id from public.obligation_types where code = 'jaarafsluiting'),
    '2026', current_date, current_date, 'open', v_emp, 'automatisch_gegenereerd', true
  );
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

  insert into public.task_instances (
    client_id, obligation_type_id, client_obligation_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, v_co, '2029', current_date + 30, current_date + 30,
    'open', v_mw, 'automatisch_gegenereerd', true
  ) returning id into v_task;

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
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, '2030', date '2030-04-15', date '2030-04-15',
    'open', v_emp, 'automatisch_gegenereerd', true
  ) returning id into v_task;
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
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, '2031', v_woensdag, v_woensdag, 'open', v_admin, 'automatisch_gegenereerd', true
  ) returning id into v_task;

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
    insert into public.task_instances (
      client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
      status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
    ) values (
      v_client, v_ot, '2032-x', current_date + 10, current_date + 10,
      'open', v_emp_b, 'automatisch_gegenereerd', true
    );
  exception when others then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 12.1: taak aangemaakt voor een medewerker van een ander kantoor';
  end if;
  raise notice 'PASS 12.1: taak aanmaken over de kantoorgrens heen wordt geweigerd';

  -- 12.2 Herverdelen naar het andere kantoor.
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_client, v_ot, '2032', current_date + 10, current_date + 10,
    'open', v_emp_a, 'automatisch_gegenereerd', true
  ) returning id into v_task;

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

  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (v_client, v_ot, '2033-a', current_date + 20, current_date + 20, 'open', v_mw, 'automatisch_gegenereerd', true)
  returning id into v_t1;

  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (v_client, v_ot, '2033-b', current_date + 25, current_date + 25, 'open', v_admin, 'automatisch_gegenereerd', true)
  returning id into v_t2;

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
    insert into public.task_instances (
      client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
      status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
    ) values (v_client2, v_ot, '2033-c', current_date + 30, current_date + 30, 'open', v_mw, 'automatisch_gegenereerd', true)
    returning id into v_new;
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

select '=== ALL RECURRENCE ENGINE TESTS PASSED ===' as result;
