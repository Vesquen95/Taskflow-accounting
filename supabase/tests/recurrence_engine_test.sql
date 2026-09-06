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
  -- Sinds 0037 is dit de vroegste van twee data en niet meer alleen de
  -- afronding + 30. Ging de AV later door dan gepland, dan blijft de
  -- neerlegging op de geplande datum + 30 staan: te laat vergaderen geeft geen
  -- extra tijd om neer te leggen. Ging ze vroeger door, dan schuift ze mee naar
  -- voren, want de wettelijke termijn van dertig dagen loopt vanaf de
  -- goedkeuring.
  perform pg_temp.test_assert(
    v_post_due_wettelijk = least(v_post_afgerond_op::date, v_av_due_wettelijk) + 30,
    'AV -> neerlegging: due_date_wettelijk = the earlier of (real completion + 30) and (planned AV + 30)'
  );
  perform pg_temp.test_assert(
    v_post_due_wettelijk <= v_av_due_wettelijk + 30,
    'AV -> neerlegging: the recalculation never pushes the deadline past the planned AV + 30 days'
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
-- de regels hierboven bootsen dat na. De dode kanban-tabellen hoefden hier
-- vroeger met de hand ingetrokken te worden (migratie 0014); sinds 0024 zijn
-- ze helemaal weg, dus er valt niets meer in te trekken.

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
-- de regels hierboven bootsen dat na. De dode kanban-tabellen hoefden hier
-- vroeger met de hand ingetrokken te worden (migratie 0014); sinds 0024 zijn
-- ze helemaal weg, dus er valt niets meer in te trekken.

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
  v_voorlopig boolean; v_wettelijk date; v_due date; v_handmatig timestamptz; v_av_gepland date;
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
  -- Sinds 0037 de vroegste van (afronding + 30) en (geplande AV + 30). Deze
  -- fixture heeft een AV-datum in het verleden, dus de geplande datum wint:
  -- een AV die te laat gehouden wordt, geeft geen extra tijd om neer te leggen.
  select due_date_wettelijk into v_av_gepland from public.task_instances where id = v_av2;
  if v_wettelijk <> least(current_date, v_av_gepland) + 30 then
    raise exception 'FAIL 20.5: neerleggingsdatum % i.p.v. % (geplande AV %, afgerond vandaag)',
      v_wettelijk, least(current_date, v_av_gepland) + 30, v_av_gepland;
  end if;
  raise notice 'PASS 20.5: afronden van de nieuwe AV levert een definitieve neerleggingsdatum (%)', v_wettelijk;

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
  -- De uitgangstoestand nakijken gebeurt BUITEN de rol van de gebruiker:
  -- can_view_client() is sinds 0055 niet meer door `authenticated` op te
  -- roepen, precies omdat ze over een willekeurige collega antwoordt. Dat is
  -- hier geen verlies -- dit is een fixturecontrole, geen gedrag dat de app
  -- gebruikt.
  if public.can_view_client(v_vertr, v_mw2) then
    raise exception 'FAIL 20.9: de collega zag het vertrouwelijke dossier al voor de toewijzing';
  end if;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;

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
  -- 21.9 De dode kanban-tabellen bestaan niet meer.
  -- 0014 trok de rechten erop in; 0024 heeft ze helemaal verwijderd. Dat is de
  -- sterkere garantie: een tabel die er niet is kan door een latere `grant`
  -- ook niet per ongeluk weer opengezet worden.
  set local role postgres;
  select count(*) into v_cnt from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('boards', 'columns', 'labels', 'tasks', 'task_labels');
  if v_cnt <> 0 then
    raise exception 'FAIL 21.9: % dode kanban-tabel(len) staan er nog', v_cnt;
  end if;
  raise notice 'PASS 21.9: de dode kanban-tabellen bestaan niet meer';

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

-- ============================================================
-- Sectie 25 (0017): btw-kwartaaltermijn en de voorafbetalingen.
--
-- Beide bevestigd door het kantoor:
--   * maandaangifte de 20ste, kwartaalaangifte de 25ste. De kwartaaltak
--     rekende + 19 (de 20ste) en lag dus vijf dagen te vroeg.
--   * voorafbetalingen 10/4, 10/7, 10/10 en 20/12 bij een afsluiting per
--     31/12, en meeschuivend wanneer het boekjaar op 31/3, 30/6 of 30/9
--     eindigt. De oude formule ankerde op het boekjaarbegin.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_uid uuid := gen_random_uuid();
  v_kw uuid; v_mnd uuid; v_dec uuid; v_maa uuid; v_ot_va uuid;
  v_due date; v_cnt int;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's25@test.local', now());
  insert into public.firms (naam) values ('Sectie 25 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S25 Beheerder', 's25@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_uid::text, true);
  select id into v_ot_va from public.obligation_types where code = 'va_venb';

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S25 Kwartaalaangever', 12, 31, 'periodieke_aangever', 'kwartaal', true)
    returning id into v_kw;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S25 Maandaangever', 12, 31, 'periodieke_aangever', 'maand', true)
    returning id into v_mnd;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S25 Boekjaar 31-12', 12, 31, 'geen', true) returning id into v_dec;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S25 Boekjaar 31-03', 3, 31, 'geen', true) returning id into v_maa;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
    values (v_dec, v_ot_va, true, date '2000-01-01', v_admin),
           (v_maa, v_ot_va, true, date '2000-01-01', v_admin);

  -- De btw-verplichtingen komen van de sync-trigger op clients en krijgen
  -- geldig_vanaf = vandaag. Sinds 0018 snijdt dat alles uit het verleden weg,
  -- terwijl deze sectie juist een afgelopen kwartaal nodig heeft. Dit zijn
  -- dossiers die het kantoor al jaren doet, dus zetten we dat ook zo.
  update public.client_obligations set geldig_vanaf = date '2000-01-01'
  where client_id in (v_kw, v_mnd);

  perform public.generate_task_instances(36, 24);

  -- 25.1 Kwartaalaangifte: de 25ste van de maand na het kwartaal.
  select count(*) into v_cnt
  from public.task_instances ti join public.obligation_types ot on ot.id = ti.obligation_type_id
  where ti.client_id = v_kw and ot.code = 'btw_aangifte'
    and extract(day from ti.due_date_wettelijk) <> 25;
  if v_cnt <> 0 then
    raise exception 'FAIL 25.1: % kwartaalaangiften staan niet op de 25ste', v_cnt;
  end if;
  select count(*) into v_cnt
  from public.task_instances ti join public.obligation_types ot on ot.id = ti.obligation_type_id
  where ti.client_id = v_kw and ot.code = 'btw_aangifte';
  if v_cnt = 0 then
    raise exception 'FAIL 25.1: er werden helemaal geen kwartaalaangiften gegenereerd';
  end if;
  raise notice 'PASS 25.1: alle % kwartaalaangiften staan op de 25ste', v_cnt;

  -- 25.2 Maandaangifte blijft op de 20ste.
  select count(*) into v_cnt
  from public.task_instances ti join public.obligation_types ot on ot.id = ti.obligation_type_id
  where ti.client_id = v_mnd and ot.code = 'btw_aangifte'
    and extract(day from ti.due_date_wettelijk) <> 20;
  if v_cnt <> 0 then
    raise exception 'FAIL 25.2: % maandaangiften staan niet op de 20ste', v_cnt;
  end if;
  raise notice 'PASS 25.2: de maandaangifte blijft op de 20ste';

  -- 25.3 Voorafbetalingen bij een afsluiting per 31/12.
  select due_date_wettelijk into v_due from public.task_instances
  where client_id = v_dec and periode_label = 'VA1-2026';
  if v_due is distinct from date '2026-04-10' then
    raise exception 'FAIL 25.3: VA1-2026 staat op % i.p.v. 10/04/2026', v_due;
  end if;
  select due_date_wettelijk into v_due from public.task_instances
  where client_id = v_dec and periode_label = 'VA2-2026';
  if v_due is distinct from date '2026-07-10' then
    raise exception 'FAIL 25.3: VA2-2026 staat op % i.p.v. 10/07/2026', v_due;
  end if;
  select due_date_wettelijk into v_due from public.task_instances
  where client_id = v_dec and periode_label = 'VA3-2026';
  if v_due is distinct from date '2026-10-10' then
    raise exception 'FAIL 25.3: VA3-2026 staat op % i.p.v. 10/10/2026', v_due;
  end if;
  select due_date_wettelijk into v_due from public.task_instances
  where client_id = v_dec and periode_label = 'VA4-2026';
  if v_due is distinct from date '2026-12-20' then
    raise exception 'FAIL 25.3: VA4-2026 staat op % i.p.v. 20/12/2026', v_due;
  end if;
  raise notice 'PASS 25.3: bij 31/12 staan de VA op 10/4, 10/7, 10/10 en 20/12';

  -- 25.4 En bij een boekjaar dat op 31/03 eindigt schuift het schema mee:
  -- de vierde valt op de 20ste van de laatste maand van het boekjaar.
  select due_date_wettelijk into v_due from public.task_instances
  where client_id = v_maa and periode_label = 'VA1-2026';
  if v_due is distinct from date '2025-07-10' then
    raise exception 'FAIL 25.4: VA1 bij boekjaar 31/03/2026 staat op % i.p.v. 10/07/2025', v_due;
  end if;
  select due_date_wettelijk into v_due from public.task_instances
  where client_id = v_maa and periode_label = 'VA2-2026';
  if v_due is distinct from date '2025-10-10' then
    raise exception 'FAIL 25.4: VA2 bij boekjaar 31/03/2026 staat op % i.p.v. 10/10/2025', v_due;
  end if;
  select due_date_wettelijk into v_due from public.task_instances
  where client_id = v_maa and periode_label = 'VA3-2026';
  if v_due is distinct from date '2026-01-10' then
    raise exception 'FAIL 25.4: VA3 bij boekjaar 31/03/2026 staat op % i.p.v. 10/01/2026', v_due;
  end if;
  select due_date_wettelijk into v_due from public.task_instances
  where client_id = v_maa and periode_label = 'VA4-2026';
  if v_due is distinct from date '2026-03-20' then
    raise exception 'FAIL 25.4: VA4 bij boekjaar 31/03/2026 staat op % i.p.v. 20/03/2026', v_due;
  end if;
  raise notice 'PASS 25.4: bij boekjaar 31/03 schuift het VA-schema correct mee';

  -- 25.5 De keuze van het kantoor: de verschuiving naar de eerstvolgende
  -- werkdag geldt voor ALLE btw-aangiften, ook de kwartaalaangifte. 25/04/2026
  -- is een zaterdag, dus de effectieve datum moet maandag 27/04 zijn terwijl
  -- de wettelijke datum op 25/04 blijft staan.
  select due_date into v_due from public.task_instances ti
  join public.obligation_types ot on ot.id = ti.obligation_type_id
  where ti.client_id = v_kw and ot.code = 'btw_aangifte' and ti.periode_label = '2026-Q1';
  if v_due is distinct from date '2026-04-27' then
    raise exception 'FAIL 25.5: de kwartaaldeadline van 2026-Q1 schoof naar % i.p.v. 27/04/2026', v_due;
  end if;
  select due_date_wettelijk into v_due from public.task_instances ti
  join public.obligation_types ot on ot.id = ti.obligation_type_id
  where ti.client_id = v_kw and ot.code = 'btw_aangifte' and ti.periode_label = '2026-Q1';
  if v_due is distinct from date '2026-04-25' then
    raise exception 'FAIL 25.5: de wettelijke datum van 2026-Q1 werd meeverschoven (%)', v_due;
  end if;
  raise notice 'PASS 25.5: de werkdagverschuiving geldt ook voor de kwartaalaangifte';
end $$;

-- ============================================================
-- Sectie 26 (0018): geen taken met een deadline in het verleden.
--
-- Gemeten voor 0018, op een klant die vandaag wordt aangemaakt met de
-- standaardaanroep van de app (3 vooruit, 6 terug): 10 taken, waarvan 8 met
-- een deadline die al gepasseerd was. Bij ~100 dossiers honderden regels ruis.
-- De ondergrens is nu per verplichting greatest(venster, geldig_vanaf).
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_uid uuid := gen_random_uuid();
  v_nieuw uuid; v_bestaand uuid; v_grens uuid;
  v_totaal int; v_verleden int; v_ot_btw uuid; v_grensdatum date;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's26@test.local', now());
  insert into public.firms (naam) values ('Sectie 26 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S26 Beheerder', 's26@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_uid::text, true);

  -- 26.1 Een klant die vandaag wordt aangemaakt krijgt uitsluitend toekomst.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S26 Nieuw vandaag', 12, 31, 'periodieke_aangever', 'kwartaal', true)
    returning id into v_nieuw;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
  select v_nieuw, id, true, current_date, v_admin
  from public.obligation_types where code in ('va_venb', 'jaarafsluiting', 'algemene_vergadering');

  perform public.generate_task_instances(3, 6);

  select count(*), count(*) filter (where due_date < current_date)
    into v_totaal, v_verleden
  from public.task_instances where client_id = v_nieuw;

  if v_verleden <> 0 then
    raise exception 'FAIL 26.1: nieuwe klant kreeg % taken met een deadline in het verleden (van de % in totaal)',
      v_verleden, v_totaal;
  end if;
  if v_totaal = 0 then
    raise exception 'FAIL 26.1: nieuwe klant kreeg helemaal geen taken -- de ondergrens snijdt te veel weg';
  end if;
  raise notice 'PASS 26.1: nieuwe klant krijgt % taken, geen enkele in het verleden', v_totaal;

  -- 26.2 Een dossier dat het kantoor al langer doet houdt zijn terugkijkvenster:
  -- geldig_vanaf ligt daar ver genoeg terug, dus het globale venster telt weer.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S26 Al twee jaar klant', 12, 31, 'periodieke_aangever', 'kwartaal', true)
    returning id into v_bestaand;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
  select v_bestaand, id, true, (current_date - interval '2 years')::date, v_admin
  from public.obligation_types where code in ('va_venb', 'jaarafsluiting', 'algemene_vergadering');

  perform public.generate_task_instances(3, 6);

  select count(*) filter (where due_date < current_date) into v_verleden
  from public.task_instances where client_id = v_bestaand;
  if v_verleden = 0 then
    raise exception 'FAIL 26.2: een bestaand dossier kreeg geen enkele taak uit het terugkijkvenster meer';
  end if;
  raise notice 'PASS 26.2: een bestaand dossier houdt zijn terugkijkvenster (% taken)', v_verleden;

  -- 26.3 De grens ligt op de DEADLINE, niet op de periode. Neem je een dossier
  -- over op dag X, dan hoort een periode die vóór X afliep er nog bij zolang de
  -- indieningsdatum ná X valt -- die aangifte moet het kantoor nog doen.
  --
  -- De grensdatum ligt op de EERSTE van deze maand. Voor een maandaangever
  -- betekent dat: de vorige maand is afgelopen (periode-einde vóór de eerste)
  -- terwijl haar deadline pas op de 20ste van deze maand valt, dus ná de grens.
  --
  -- Ze lag hier eerst op de 6de, en dat hield het niet: op de eerste vijf
  -- dagen van een maand ligt die datum in de TOEKOMST, en dan slaat de motor
  -- de verplichting helemaal over -- terecht, want ze is nog niet begonnen
  -- (`co.geldig_vanaf <= current_date`). De test viel dus elke maand vijf
  -- dagen lang om, en dat kwam pas op 2 september boven. De eerste van de
  -- maand is nooit in de toekomst en houdt het scenario intact.
  select id into v_ot_btw from public.obligation_types where code = 'btw_aangifte';
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S26 Grensgeval', 12, 31, 'periodieke_aangever', 'maand', true)
    returning id into v_grens;

  v_grensdatum := date_trunc('month', current_date)::date;
  update public.client_obligations set geldig_vanaf = v_grensdatum where client_id = v_grens;

  perform public.generate_task_instances(3, 6);

  select count(*) into v_totaal
  from public.task_instances ti
  where ti.client_id = v_grens and ti.obligation_type_id = v_ot_btw
    and ti.periode_eind < v_grensdatum
    and ti.due_date >= v_grensdatum;
  if v_totaal = 0 then
    raise exception 'FAIL 26.3: een periode die vóór de grens afliep maar pas erna moet ingediend worden, werd weggesneden';
  end if;

  select count(*) into v_verleden
  from public.task_instances ti
  where ti.client_id = v_grens and ti.due_date < v_grensdatum;
  if v_verleden <> 0 then
    raise exception 'FAIL 26.3: % taken met een deadline vóór de grensdatum werden toch aangemaakt', v_verleden;
  end if;
  raise notice 'PASS 26.3: de grens ligt op de deadline, niet op de periode (% taak/taken behouden)', v_totaal;
end $$;

-- ============================================================
-- Sectie 27 (0019): de aangifte VenB/PB wordt berekend, en de wettelijke
-- kalender is een echte override.
--
-- Vóór 0019 maakte de motor nul aangiftetaken aan: de datum werd uitsluitend
-- opgezocht in legal_calendar per boekjaarcohort, en zonder rij werd de
-- periode overgeslagen -- geen taak, geen melding. En een override die je
-- daarna wél invulde verzette bestaande taken niet, omdat de scope als
-- tekstfragment van het periodelabel gematcht werd ('2026' ilike
-- '%boekjaar_12%' is nooit waar).
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_uid uuid := gen_random_uuid();
  v_ot_aang uuid; v_klant uuid; v_n int; v_due date;
  v_maand int; v_verwacht date;
  v_gevallen int[][] := array[[12,31],[6,30],[9,30],[3,31]];
  v_i int;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's27@test.local', now());
  insert into public.firms (naam) values ('Sectie 27 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S27 Beheerder', 's27@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_uid::text, true);
  select id into v_ot_aang from public.obligation_types where code = 'aangifte_venb_pb';

  for v_i in 1..4 loop
    insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
      values (v_firm, 'S27 sluit maand ' || v_gevallen[v_i][1], v_gevallen[v_i][1], v_gevallen[v_i][2], 'geen', true)
      returning id into v_klant;
    insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
      values (v_klant, v_ot_aang, true, date '2000-01-01', v_admin);
  end loop;

  perform public.generate_task_instances(36, 24);

  -- 27.1 Er komen überhaupt aangiftetaken, zonder één kalenderrij.
  select count(*) into v_n from public.task_instances where obligation_type_id = v_ot_aang;
  if v_n = 0 then
    raise exception 'FAIL 27.1: de motor maakte geen enkele aangiftetaak aan';
  end if;
  -- Bewijzen dat de datums van 2026 uit de formule komen en niet uit een
  -- kalenderrij. Andere secties zetten rijen voor andere jaren; alleen 2026
  -- telt hier.
  select count(*) into v_n from public.legal_calendar
  where obligation_type_id = v_ot_aang and jaar = 2026;
  if v_n <> 0 then
    raise exception 'FAIL 27.1: er stond al een kalenderrij voor 2026; de test bewijst dan niets';
  end if;
  raise notice 'PASS 27.1: aangiftetaken worden aangemaakt zonder kalenderrij';

  -- 27.2 De wettelijke termijn per cohort, met de datums voluit.
  --
  -- Deze test rekende de verwachting eerst zelf uit met dezelfde formule als de
  -- motor -- en legde daarmee de fout vast die 0033 rechtzette: een boekjaar
  -- op 31/12 kreeg 31/07 in plaats van 30/09. Een test die de formule van de
  -- code overneemt, toetst niets; ze bevestigt alleen dat de code doet wat de
  -- code doet. Daarom staan de datums hier voluit.
  for v_i in 1..4 loop
    v_maand := v_gevallen[v_i][1];
    select ti.due_date_wettelijk into v_due
    from public.task_instances ti join public.clients c on c.id = ti.client_id
    where ti.obligation_type_id = v_ot_aang and ti.periode_label = '2026'
      and c.boekjaar_einde_maand = v_maand;
    v_verwacht := case v_maand
      when 12 then date '2027-09-30'  -- winterafsluiting: 30 september
      when 6  then date '2027-01-31'
      when 9  then date '2027-04-30'
      when 3  then date '2026-10-31'
    end;
    if v_due is distinct from v_verwacht then
      raise exception 'FAIL 27.2: boekjaareinde maand % gaf % i.p.v. %', v_maand, v_due, v_verwacht;
    end if;
  end loop;
  raise notice 'PASS 27.2: 31/12->30/09, 30/06->31/01, 30/09->30/04, 31/03->31/10';

  -- 27.3 Een aangekondigde campagnedatum wint, ook van een taak die al bestaat.
  -- Bewust een datum die de formule NIET geeft: sinds 0033 rekent die voor een
  -- 31/12-dossier zelf al 30/09/2027 uit, en dan zou deze test niet meer
  -- kunnen zien of de override iets deed.
  insert into public.legal_calendar (obligation_type_id, jaar, scope, deadline_datum, is_override, aangemaakt_door, gewijzigd_door)
  values (v_ot_aang, 2026, 'boekjaar_12', date '2027-10-15', true, v_admin, v_admin);

  select ti.due_date_wettelijk into v_due
  from public.task_instances ti join public.clients c on c.id = ti.client_id
  where ti.obligation_type_id = v_ot_aang and ti.periode_label = '2026' and c.boekjaar_einde_maand = 12;
  if v_due is distinct from date '2027-10-15' then
    raise exception 'FAIL 27.3: de override verzette de bestaande taak niet (% i.p.v. 15/10/2027)', v_due;
  end if;

  -- en raakt alleen het cohort dat ze noemt.
  select ti.due_date_wettelijk into v_due
  from public.task_instances ti join public.clients c on c.id = ti.client_id
  where ti.obligation_type_id = v_ot_aang and ti.periode_label = '2026' and c.boekjaar_einde_maand = 6;
  if v_due is distinct from date '2027-01-31' then
    raise exception 'FAIL 27.3: de override van het 31/12-cohort raakte ook het 30/06-cohort (%)', v_due;
  end if;
  raise notice 'PASS 27.3: de override verzet bestaande taken, en enkel het genoemde cohort';
end $$;

-- ============================================================
-- Sectie 28 (0020): de algemene vergadering krijgt haar statutaire datum.
--
-- Vóór 0020 rekende de motor de AV op boekjaareinde + 6 maanden -- de
-- wettelijke uiterste datum, niet de datum uit de statuten. Een klant met
-- "de eerste maandag van april" stond op 30 juni, en omdat de neerlegging
-- AV + 30 dagen is schoof die fout door naar de neerleggingsdatum.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_uid uuid := gen_random_uuid();
  v_klant uuid; v_c06 uuid; v_co uuid;
  v_ot_av uuid; v_ot_neer uuid;
  v_av date; v_neer date; v_cnt int; v_ok boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's28@test.local', now());
  insert into public.firms (naam) values ('Sectie 28 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S28 Beheerder', 's28@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_uid::text, true);
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';
  select id into v_ot_neer from public.obligation_types where code = 'neerlegging_jaarrekening';

  -- 28.1 De berekening zelf, beide vormen, inclusief de randgevallen.
  if public.av_datum(date '2026-12-31', '{"av_vorm":"vaste_datum","av_maand":4,"av_dag":1}') is distinct from date '2027-04-01' then
    raise exception 'FAIL 28.1: vaste datum 1 april na 31/12/2026';
  end if;
  if public.av_datum(date '2026-12-31', '{"av_vorm":"nde_weekdag","av_maand":4,"av_rang":"eerste","av_weekdag":"maandag"}') is distinct from date '2027-04-05' then
    raise exception 'FAIL 28.1: eerste maandag van april 2027 is 05/04';
  end if;
  if public.av_datum(date '2026-12-31', '{"av_vorm":"nde_weekdag","av_maand":6,"av_rang":"derde","av_weekdag":"vrijdag"}') is distinct from date '2027-06-18' then
    raise exception 'FAIL 28.1: derde vrijdag van juni 2027 is 18/06';
  end if;
  if public.av_datum(date '2026-12-31', '{"av_vorm":"nde_weekdag","av_maand":6,"av_rang":"laatste","av_weekdag":"vrijdag"}') is distinct from date '2027-06-25' then
    raise exception 'FAIL 28.1: laatste vrijdag van juni 2027 is 25/06';
  end if;
  -- Een boekjaar dat niet op 31/12 eindigt: de eerstvolgende gelegenheid erna.
  if public.av_datum(date '2026-06-30', '{"av_vorm":"vaste_datum","av_maand":12,"av_dag":1}') is distinct from date '2026-12-01' then
    raise exception 'FAIL 28.1: 1 december na een boekjaar dat op 30/06/2026 sluit';
  end if;
  -- Onmogelijke of onvolledige statuten leveren geen datum op.
  if public.av_datum(date '2026-12-31', '{"av_vorm":"vaste_datum","av_maand":4,"av_dag":31}') is not null then
    raise exception 'FAIL 28.1: 31 april bestaat niet en mag geen datum opleveren';
  end if;
  if public.av_datum(date '2026-12-31', '{"av_vorm":"nde_weekdag","av_maand":4,"av_rang":"eerste"}') is not null then
    raise exception 'FAIL 28.1: een ontbrekende weekdag mag geen datum opleveren';
  end if;
  raise notice 'PASS 28.1: beide statutaire vormen rekenen correct, ook de randgevallen';

  -- 28.2 Een datum buiten de wettelijke termijn wordt geweigerd bij het invullen.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S28 Sluit 30/06', 6, 30, 'geen', true) returning id into v_c06;
  v_ok := false;
  begin
    insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters, standaard_toegewezen_medewerker_id)
    values (v_c06, v_ot_av, true, date '2000-01-01',
            '{"av_vorm":"vaste_datum","av_maand":4,"av_dag":1}'::jsonb, v_admin);
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 28.2: een AV op 1 april werd aanvaard voor een boekjaar dat op 30/06 sluit';
  end if;
  -- Binnen de termijn mag het wel.
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters, standaard_toegewezen_medewerker_id)
  values (v_c06, v_ot_av, true, date '2000-01-01',
          '{"av_vorm":"vaste_datum","av_maand":12,"av_dag":1}'::jsonb, v_admin);
  raise notice 'PASS 28.2: buiten de zesmaandentermijn wordt geweigerd, binnen aanvaard';

  -- 28.3 De motor gebruikt de statutaire datum, en de neerlegging volgt.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S28 Statuten', 12, 31, 'geen', true) returning id into v_klant;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters, standaard_toegewezen_medewerker_id)
    values (v_klant, v_ot_av, true, date '2000-01-01',
            '{"av_vorm":"nde_weekdag","av_maand":4,"av_rang":"eerste","av_weekdag":"maandag"}'::jsonb, v_admin)
    returning id into v_co;

  perform public.generate_task_instances(36, 24);

  select due_date_wettelijk into v_av from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_av and periode_label = '2026';
  if v_av is distinct from date '2027-04-05' then
    raise exception 'FAIL 28.3: de AV staat op % i.p.v. de statutaire 05/04/2027', v_av;
  end if;
  select due_date_wettelijk into v_neer from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_neer and periode_label = '2026';
  if v_neer is distinct from date '2027-05-05' then
    raise exception 'FAIL 28.3: de neerlegging staat op % i.p.v. AV + 30 dagen (05/05/2027)', v_neer;
  end if;
  raise notice 'PASS 28.3: de motor gebruikt de statutaire datum en de neerlegging volgt';

  -- 28.4 Een statutenwijziging schuift alles mee, met een spoor.
  update public.client_obligations
  set parameters = '{"av_vorm":"nde_weekdag","av_maand":6,"av_rang":"derde","av_weekdag":"vrijdag"}'::jsonb
  where id = v_co;

  select due_date_wettelijk into v_av from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_av and periode_label = '2026';
  if v_av is distinct from date '2027-06-18' then
    raise exception 'FAIL 28.4: de AV schoof niet mee (% i.p.v. 18/06/2027)', v_av;
  end if;
  select due_date_wettelijk into v_neer from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_neer and periode_label = '2026';
  if v_neer is distinct from date '2027-07-18' then
    raise exception 'FAIL 28.4: de neerlegging schoof niet mee (% i.p.v. 18/07/2027)', v_neer;
  end if;

  select count(*) into v_cnt from public.task_status_log l
  join public.task_instances t on t.id = l.task_instance_id
  where t.client_id = v_klant and l.notitie like '%statutaire AV-datum is gewijzigd%';
  if v_cnt = 0 then
    raise exception 'FAIL 28.4: de verschuiving liet geen spoor na op de AV-taken';
  end if;
  select count(*) into v_cnt from public.client_change_log
  where client_id = v_klant and veld = 'av_statutaire_datum';
  if v_cnt <> 1 then
    raise exception 'FAIL 28.4: de statutenwijziging staat niet in het klantwijzigingslog (%)', v_cnt;
  end if;
  raise notice 'PASS 28.4: een statutenwijziging schuift AV en neerlegging mee, en wordt geaudit';

  -- 28.5 Zonder ingevulde statuten blijft de wettelijke uiterste datum gelden.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S28 Zonder statuten', 12, 31, 'geen', true) returning id into v_klant;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
    values (v_klant, v_ot_av, true, date '2000-01-01', v_admin);
  perform public.generate_task_instances(36, 24);
  select due_date_wettelijk into v_av from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_av and periode_label = '2026';
  if v_av is distinct from date '2027-06-30' then
    raise exception 'FAIL 28.5: zonder statuten hoort de wettelijke uiterste datum te gelden (% i.p.v. 30/06/2027)', v_av;
  end if;
  raise notice 'PASS 28.5: zonder ingevulde statuten geldt de wettelijke uiterste datum';
end $$;

-- ============================================================
-- Sectie 29 (0021): taken bij- en afmaken bij het opslaan van een klant.
--
-- Het kantoor: "taken kunnen bijkomen, zoals een rapportering, of kunnen
-- wegvallen, zoals de btw-aangiftes. Die moeten dan ook gemaakt of verwijderd
-- worden bij het opslaan. Niet door een afzonderlijke triggerknop."
--
-- De generatie liep tot nu toe over het HELE kantoor en was voorbehouden aan
-- een kantoorbeheerder. Dat is juist voor het opschuiven van de horizon, maar
-- fout voor het opslaan van één klant: dat is dagelijks werk van wie het
-- dossier beheert.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_mw uuid;
  v_admin_uid uuid := gen_random_uuid(); v_mw_uid uuid := gen_random_uuid();
  v_klant uuid; v_vreemd uuid; v_firm2 uuid;
  v_ot_rap uuid; v_ot_btw uuid; v_co_btw uuid;
  v_n int; v_open int; v_geann int; v_ok boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_admin_uid, 's29-admin@test.local', now()),
    (v_mw_uid, 's29-mw@test.local', now());
  insert into public.firms (naam) values ('Sectie 29 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S29 Beheerder', 's29-admin@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'S29 Medewerker', 's29-mw@test.local', 'medewerker', false, true)
    returning id into v_mw;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  select id into v_ot_rap from public.obligation_types where code = 'rapportering';
  select id into v_ot_btw from public.obligation_types where code = 'btw_aangifte';

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S29 Klant', 12, 31, 'periodieke_aangever', 'kwartaal', true)
    returning id into v_klant;

  -- 29.1 Een gewone medewerker kan de taken van zijn klant bijwerken; daar is
  -- geen kantoorbeheerder voor nodig.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  v_n := public.sync_client_tasks(v_klant);
  set local role postgres;
  if v_n <= 0 then
    raise exception 'FAIL 29.1: het opslaan leverde geen taken op (%)', v_n;
  end if;
  raise notice 'PASS 29.1: een medewerker werkt de taken van zijn klant bij (% taken)', v_n;

  -- 29.2 Een verplichting erbij: haar taken verschijnen bij het opslaan.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
    values (v_klant, v_ot_rap, true, current_date, v_mw);
  v_n := public.sync_client_tasks(v_klant);
  set local role postgres;
  select count(*) into v_open from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_rap and status = 'open';
  if v_open = 0 then
    raise exception 'FAIL 29.2: een toegevoegde verplichting leverde geen taken op';
  end if;
  raise notice 'PASS 29.2: een toegevoegde verplichting krijgt haar taken (% open)', v_open;

  -- 29.3 Een verplichting eraf: haar open toekomstige taken worden geannuleerd,
  -- niet verwijderd. De rest van het dossier blijft ongemoeid.
  select id into v_co_btw from public.client_obligations
   where client_id = v_klant and obligation_type_id = v_ot_btw;
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  update public.client_obligations set actief = false, geldig_tot = current_date where id = v_co_btw;
  v_n := public.sync_client_tasks(v_klant);
  set local role postgres;

  select count(*) filter (where status = 'open'), count(*) filter (where status = 'geannuleerd')
    into v_open, v_geann
  from public.task_instances where client_id = v_klant and obligation_type_id = v_ot_btw;
  if v_open <> 0 then
    raise exception 'FAIL 29.3: % btw-taken bleven open na het afzetten van de verplichting', v_open;
  end if;
  if v_geann = 0 then
    raise exception 'FAIL 29.3: de btw-taken werden niet geannuleerd';
  end if;
  select count(*) into v_open from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_rap and status = 'open';
  if v_open = 0 then
    raise exception 'FAIL 29.3: het afzetten van de btw raakte ook de rapportering';
  end if;
  raise notice 'PASS 29.3: afgezette verplichting -> % taken geannuleerd, de rest blijft (% open)', v_geann, v_open;

  -- 29.4 Alleen voor dossiers waar je bij mag. De poort is dezelfde als die
  -- van de RLS, inclusief de vertrouwelijkheidsregel.
  insert into public.firms (naam) values ('S29 Ander kantoor') returning id into v_firm2;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm2, 'S29 Vreemde klant', 12, 31, 'geen', true) returning id into v_vreemd;

  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    perform public.sync_client_tasks(v_vreemd);
  exception when insufficient_privilege then v_ok := true;
  end;
  set local role postgres;
  if not v_ok then
    raise exception 'FAIL 29.4: een klant van een ander kantoor kon bijgewerkt worden';
  end if;
  raise notice 'PASS 29.4: bijwerken kan alleen op dossiers waar je toegang toe hebt';

  -- 29.5 De batch blijft voorbehouden aan de kantoorbeheerder: dat is
  -- horizon-onderhoud, geen klantwijziging.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    perform public.generate_task_instances(3, 6);
  exception when others then v_ok := true;
  end;
  set local role postgres;
  if not v_ok then
    raise exception 'FAIL 29.5: een medewerker kon de batchgeneratie starten';
  end if;
  raise notice 'PASS 29.5: de batch blijft voorbehouden aan de kantoorbeheerder';

  -- 29.6 De teller telt binnen het eigen kantoor (bevinding I uit ronde zes).
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  v_n := public.generate_task_instances(3, 6);
  set local role postgres;
  if v_n <> 0 then
    raise exception 'FAIL 29.6: een tweede ronde leverde % nieuwe taken op i.p.v. 0', v_n;
  end if;
  raise notice 'PASS 29.6: de teller telt per kantoor, niet instance-breed';
end $$;


-- ============================================================
-- Sectie 30 (0022): werkstromen -- de indeling waarin het kantoor werkt.
--
-- Het kantoor: "ik wil alle btw aangiftes afwerken deze week dus ik wil enkel
-- de BTW aangiftes zien". Met ~100 dossiers is één lijst met alles onwerkbaar.
--
-- De indeling hoort in de catalogus en niet in de schermcode: één plek, en een
-- nieuw verplichtingstype valt vanzelf ergens in plaats van stilzwijgend
-- nergens. Dat "nergens" is hier het echte risico -- een type zonder werkstroom
-- zou uit elke ingang verdwijnen en dus onzichtbaar worden.
-- ============================================================
do $$
declare
  v_zonder int; v_n int; v_ok boolean;
  v_uid uuid := gen_random_uuid(); v_firm uuid;
begin
  -- 30.1 Geen enkel verplichtingstype zit zonder werkstroom.
  select count(*) into v_zonder from public.obligation_types where werkstroom is null;
  if v_zonder > 0 then
    raise exception 'FAIL 30.1: % verplichtingstype(s) zonder werkstroom', v_zonder;
  end if;
  raise notice 'PASS 30.1: elk verplichtingstype heeft een werkstroom';

  -- 30.2 De indeling is die van het kantoor (docs/PLAN.md §10), type per type.
  select count(*) into v_n from public.obligation_types
   where werkstroom = 'btw' and code in ('btw_aangifte', 'btw_klantenlisting');
  if v_n <> 2 then
    raise exception 'FAIL 30.2: btw telt % types i.p.v. 2', v_n;
  end if;
  select count(*) into v_n from public.obligation_types
   where werkstroom = 'afsluiting'
     and code in ('jaarafsluiting', 'algemene_vergadering', 'neerlegging_jaarrekening');
  if v_n <> 3 then
    raise exception 'FAIL 30.2: afsluiting telt % types i.p.v. 3', v_n;
  end if;
  select count(*) into v_n from public.obligation_types
   where werkstroom = 'vennootschapsbelasting' and code in ('va_venb', 'aangifte_venb_pb');
  if v_n <> 2 then
    raise exception 'FAIL 30.2: vennootschapsbelasting telt % types i.p.v. 2', v_n;
  end if;
  select count(*) into v_n from public.obligation_types
   where werkstroom = 'rapportering' and code = 'rapportering';
  if v_n <> 1 then
    raise exception 'FAIL 30.2: rapportering telt % types i.p.v. 1', v_n;
  end if;
  raise notice 'PASS 30.2: de vier werkstromen bevatten precies de juiste types';

  -- 30.2b De voorafbetaling staat bij de vennootschapsbelasting, niet bij de
  -- afsluiting. Het kantoor: "voorafbetaling doen we per kwartaal bij de
  -- klanten maar hoort inhoudelijk bij de vennootschapsbelasting."
  if (select werkstroom from public.obligation_types where code = 'va_venb')
     is distinct from 'vennootschapsbelasting'::public.werkstroom then
    raise exception 'FAIL 30.2b: de voorafbetaling staat niet bij de vennootschapsbelasting';
  end if;
  -- En de rapportering staat apart, niet mee in de emmer "afsluiting" waar het
  -- kantoor juist op wil kunnen vertrouwen.
  if (select werkstroom from public.obligation_types where code = 'rapportering')
     is distinct from 'rapportering'::public.werkstroom then
    raise exception 'FAIL 30.2b: de rapportering is bij een andere werkstroom gezet';
  end if;
  raise notice 'PASS 30.2b: voorafbetaling bij VenB, rapportering apart';

  -- 30.3 Een nieuw type kan er niet zonder werkstroom bij komen. Zonder deze
  -- grendel zou een latere uitbreiding stil buiten beeld vallen.
  v_ok := false;
  begin
    insert into public.obligation_types (code, naam, categorie, deadline_mechanisme)
      values ('s30_zonder_stroom', 'S30 Zonder stroom', 'service', 'formule');
  exception when not_null_violation then v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 30.3: een verplichtingstype zonder werkstroom werd aanvaard';
  end if;
  raise notice 'PASS 30.3: een type zonder werkstroom wordt geweigerd';

  -- 30.4 De catalogus blijft voor iedereen alleen-lezen: de werkstroom is geen
  -- nieuwe schrijfweg. obligation_types heeft alleen een SELECT-policy.
  insert into auth.users (id, email, email_confirmed_at)
    values (v_uid, 's30@test.local', now());
  insert into public.firms (naam) values ('Sectie 30 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S30 Beheerder', 's30@test.local', 'kantoorbeheerder', true, true);
  perform set_config('taskflow.test_uid', v_uid::text, true);

  set local role authenticated;
  update public.obligation_types set werkstroom = 'btw' where code = 'rapportering';
  get diagnostics v_n = row_count;
  set local role postgres;
  if v_n <> 0 then
    raise exception 'FAIL 30.4: de werkstroom van een type werd via de app gewijzigd (% rijen)', v_n;
  end if;
  if (select werkstroom from public.obligation_types where code = 'rapportering')
     is distinct from 'rapportering'::public.werkstroom then
    raise exception 'FAIL 30.4: de werkstroom van de rapportering is toch veranderd';
  end if;
  raise notice 'PASS 30.4: de catalogus blijft alleen-lezen, ook voor de werkstroom';

  -- 30.5 Elke taak is via haar verplichtingstype in precies één werkstroom te
  -- plaatsen; ad-hoc taken (zonder type) vormen de vijfde ingang.
  select count(*) into v_n from public.task_instances ti
    join public.obligation_types ot on ot.id = ti.obligation_type_id
   where ot.werkstroom is null;
  if v_n > 0 then
    raise exception 'FAIL 30.5: % taken vallen buiten elke werkstroom', v_n;
  end if;
  raise notice 'PASS 30.5: elke taak met een verplichtingstype valt in één werkstroom';
end $$;


-- ============================================================
-- Sectie 31 (0023): de feestdagenkalender loopt voor op de horizon.
--
-- Aanleiding: de horizon ging naar 36 maanden terwijl public_holidays in 2027
-- ophield. Voorbij dat jaar verschoof de motor alleen nog op weekends. Dat
-- leverde in productie een AV op 1 januari 2029 op -- Nieuwjaar.
--
-- De vier bewegelijke feestdagen worden nu gerekend in plaats van overgetypt.
-- Daarom staat hier de controle die ertoe doet: de gerekende Pasen naast de
-- werkelijke data, over een reeks jaren met alle randgevallen die de computus
-- kent (vroegste, laatste, eeuwwissel).
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid(); v_uid2 uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid; v_mw uuid;
  v_n int; v_ok boolean;
  r record;
begin
  -- 31.1 Pasen, getoetst aan bekende data. Bij een fout in de computus schuift
  -- alles mee: paasmaandag, hemelvaart en pinkstermaandag.
  for r in
    select * from (values
      (2025, date '2025-04-20'), (2026, date '2026-04-05'), (2027, date '2027-03-28'),
      (2028, date '2028-04-16'), (2029, date '2029-04-01'), (2030, date '2030-04-21'),
      (2031, date '2031-04-13'), (2032, date '2032-03-28'), (2033, date '2033-04-17'),
      (2034, date '2034-04-09'), (2035, date '2035-03-25'),
      -- Randgevallen: de vroegst en laatst mogelijke paasdatum, en een
      -- eeuwwissel waar de gregoriaanse correctie meespeelt.
      (2038, date '2038-04-25'), (2008, date '2008-03-23'), (2000, date '2000-04-23')
    ) as t(jaar, verwacht)
  loop
    if public.pasen(r.jaar) <> r.verwacht then
      raise exception 'FAIL 31.1: pasen(%) gaf % i.p.v. %', r.jaar, public.pasen(r.jaar), r.verwacht;
    end if;
  end loop;
  raise notice 'PASS 31.1: de computus klopt over 14 jaren, randgevallen inbegrepen';

  -- 31.2 Tien wettelijke feestdagen per jaar, met de bewegelijke op de juiste
  -- afstand van Pasen.
  select count(*) into v_n from public.belgische_feestdagen(2029);
  if v_n <> 10 then
    raise exception 'FAIL 31.2: % feestdagen in 2029 i.p.v. 10', v_n;
  end if;
  if (select datum from public.belgische_feestdagen(2029) where omschrijving = 'Paasmaandag')
     <> date '2029-04-02' then
    raise exception 'FAIL 31.2: paasmaandag 2029 klopt niet';
  end if;
  if (select datum from public.belgische_feestdagen(2029) where omschrijving = 'O.-L.-H. Hemelvaart')
     <> date '2029-05-10' then
    raise exception 'FAIL 31.2: hemelvaart 2029 klopt niet';
  end if;
  if (select datum from public.belgische_feestdagen(2029) where omschrijving = 'Pinkstermaandag')
     <> date '2029-05-21' then
    raise exception 'FAIL 31.2: pinkstermaandag 2029 klopt niet';
  end if;
  -- Hemelvaart valt altijd op een donderdag, pinkstermaandag op een maandag.
  -- Slaat dit om, dan klopt de offset niet meer.
  for v_n in 2025 .. 2040 loop
    if extract(dow from public.pasen(v_n) + 39) <> 4 then
      raise exception 'FAIL 31.2: hemelvaart % valt niet op donderdag', v_n;
    end if;
    if extract(dow from public.pasen(v_n) + 50) <> 1 then
      raise exception 'FAIL 31.2: pinkstermaandag % valt niet op maandag', v_n;
    end if;
  end loop;
  raise notice 'PASS 31.2: tien feestdagen per jaar, bewegelijke op de juiste weekdag';

  -- Vanaf hier hebben we een kantoor nodig.
  insert into auth.users (id, email, email_confirmed_at) values
    (v_uid, 's31-admin@test.local', now()),
    (v_uid2, 's31-mw@test.local', now());
  insert into public.firms (naam) values ('Sectie 31 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S31 Beheerder', 's31-admin@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid2, 'S31 Medewerker', 's31-mw@test.local', 'medewerker', false, true)
    returning id into v_mw;

  -- 31.3 Een medewerker schuift de kalender niet vooruit: dat verzet deadlines
  -- van het hele kantoor.
  perform set_config('taskflow.test_uid', v_uid2::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    perform public.laad_feestdagen(2028, 2030);
  exception when insufficient_privilege then v_ok := true;
  end;
  set local role postgres;
  if not v_ok then
    raise exception 'FAIL 31.3: een medewerker kon de feestdagenkalender wijzigen';
  end if;
  raise notice 'PASS 31.3: vooruitschuiven is voorbehouden aan de kantoorbeheerder';

  -- 31.4 De kantoorbeheerder laadt een reeks jaren, en een tweede ronde voegt
  -- niets meer toe.
  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  v_n := public.laad_feestdagen(2028, 2030);
  set local role postgres;
  if v_n <> 30 then
    raise exception 'FAIL 31.4: % feestdagen geladen i.p.v. 30', v_n;
  end if;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  v_n := public.laad_feestdagen(2028, 2030);
  set local role postgres;
  if v_n <> 0 then
    raise exception 'FAIL 31.4: een tweede ronde voegde % rijen toe i.p.v. 0', v_n;
  end if;
  raise notice 'PASS 31.4: laden is herhaalbaar zonder dubbels';

  -- 31.5 Nieuwjaar 2029 staat er nu, dus 1 januari 2029 is geen werkdag meer.
  -- Dat is de datum waar een AV in productie op terechtkwam.
  if not exists (select 1 from public.public_holidays where datum = date '2029-01-01') then
    raise exception 'FAIL 31.5: Nieuwjaar 2029 ontbreekt na het laden';
  end if;
  if public.next_business_day(date '2028-12-30') <> date '2029-01-02' then
    raise exception 'FAIL 31.5: 30/12/2028 (zaterdag) schuift naar % i.p.v. 02/01/2029',
      public.next_business_day(date '2028-12-30');
  end if;
  raise notice 'PASS 31.5: een deadline schuift over Nieuwjaar heen, niet erop';

  -- 31.7 De grens op de greep: een tikfout mag geen duizenden rijen invoegen.
  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    perform public.laad_feestdagen(2028, 2999);
  exception when others then v_ok := true;
  end;
  set local role postgres;
  if not v_ok then
    raise exception 'FAIL 31.7: een greep van bijna duizend jaar werd aanvaard';
  end if;
  raise notice 'PASS 31.7: de greep is begrensd';
end $$;

-- ============================================================
-- Sectie 32 (0024): de opruiming blijft opgeruimd.
--
-- Dode code komt zelden in één keer terug; ze sluipt terug omdat niemand meer
-- weet dat ze weg moest. Deze sectie legt vast wat er waarom verdwenen is.
-- ============================================================
do $$
declare
  v_n int;
begin
  -- 32.1 Geen kanbanresten meer: geen tabellen, en dus ook geen policies die
  -- bij een latere `grant` stilzwijgend weer een deur openzetten.
  select count(*) into v_n from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('boards', 'columns', 'labels', 'tasks', 'task_labels');
  if v_n <> 0 then
    raise exception 'FAIL 32.1: % kanbantabel(len) zijn terug', v_n;
  end if;

  select count(*) into v_n from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('boards', 'columns', 'labels', 'tasks', 'task_labels');
  if v_n <> 0 then
    raise exception 'FAIL 32.1: % policies van de kanbantabellen staan er nog', v_n;
  end if;
  raise notice 'PASS 32.1: de kanbantabellen en hun policies zijn weg';

  -- 32.2 De herberekening bij feestdagen loopt via één functie, niet twee.
  -- recalc_due_dates_on_new_holiday() is in 0011 vervangen en bleef daarna
  -- zonder trigger achter.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'recalc_due_dates_on_new_holiday'
  ) then
    raise exception 'FAIL 32.2: de vervangen feestdagfunctie staat er weer';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'recalc_due_dates_after_holiday_change'
  ) then
    raise exception 'FAIL 32.2: de opvolger ontbreekt -- de herberekening draait nergens meer';
  end if;
  raise notice 'PASS 32.2: één feestdagherberekening, en het is de juiste';

  -- 32.3 De dekking van de feestdagenkalender wordt op één plaats gerekend:
  -- in de app (src/lib/feestdagen.ts). Een tweede versie in de database zou
  -- bij een regelwijziging onvermijdelijk achterlopen.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'feestdagen_dekking'
  ) then
    raise exception 'FAIL 32.3: feestdagen_dekking() is terug; de dekking hoort op één plaats gerekend te worden';
  end if;
  raise notice 'PASS 32.3: de dekking wordt op één plaats gerekend';

  -- 32.4 Wat wél gebruikt wordt is er nog. Deze sectie mag nooit een reden
  -- worden om iets te schrappen dat draait.
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('pasen', 'belgische_feestdagen', 'laad_feestdagen',
                       'next_business_day', 'sync_client_tasks',
                       'generate_task_instances', 'generate_task_instances_intern');
  if v_n <> 7 then
    raise exception 'FAIL 32.4: er draaien nog maar % van de 7 kernfuncties', v_n;
  end if;
  raise notice 'PASS 32.4: de functies die draaien staan er nog';
end $$;

-- ============================================================
-- Sectie 33 (0025): het horizon-onderhoud, en zijn spoor.
--
-- Aanleiding: 182 ontbrekende taken kantoorbreed, omdat de generatie sinds de
-- eerste opzet nooit meer gedraaid had. En daarnaast een feestdagenkalender die
-- achterliep op de horizon. Beide gaten hadden dezelfde vorm: werk dat met de
-- hand moest gebeuren en dat niemand herinnerde.
--
-- De automatisering mag dat gat niet vervangen door een stiller gat. Daarom
-- gaat deze sectie vooral over het spoor: elke ronde laat een rij na, ook een
-- mislukte, en niemand kan die rij achteraf bijkleuren.
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid(); v_uid2 uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid; v_klant uuid;
  v_log uuid; v_n int; v_ok boolean;
  v_taken int; v_feestdagen int; v_fout text; v_eind timestamptz;
  -- 0057: het horizonjaar volgt de horizon zelf, niet meer een vast getal.
  -- Stond hier eerst hardgecodeerd op 36 maanden; toen die op 15 ging, deleteten
  -- 33.4 en 33.2 een jaar dat het onderhoud niet meer aanraakt en sloeg de test
  -- vacuüm aan.
  v_dekking int; v_horizon int := extract(year from (current_date + (public.horizon_maanden() || ' months')::interval))::int;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_uid, 's33-admin@test.local', now()),
    (v_uid2, 's33-mw@test.local', now());
  insert into public.firms (naam) values ('Sectie 33 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S33 Beheerder', 's33-admin@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid2, 'S33 Medewerker', 's33-mw@test.local', 'medewerker', false, true);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S33 Klant', 6, 30, 'periodieke_aangever', 'kwartaal', true)
    returning id into v_klant;

  -- 33.1 De ronde draait zonder ingelogde gebruiker. Dat is de kern: cron heeft
  -- geen auth.uid(), en een onderhoudsfunctie die daarop leunt draait nooit.
  perform set_config('taskflow.test_uid', '', true);
  v_log := public.onderhoud_taken('test');
  if v_log is null then
    raise exception 'FAIL 33.1: de onderhoudsronde gaf geen logregel terug';
  end if;
  select nieuwe_taken, nieuwe_feestdagen, fout, geeindigd_op
    into v_taken, v_feestdagen, v_fout, v_eind
    from public.onderhoud_log where id = v_log;
  if v_fout is not null then
    raise exception 'FAIL 33.1: de ronde brak af met %', v_fout;
  end if;
  if v_eind is null then
    raise exception 'FAIL 33.1: de logregel werd niet afgesloten';
  end if;
  if v_taken <= 0 then
    raise exception 'FAIL 33.1: de ronde leverde % taken op i.p.v. meer dan nul', v_taken;
  end if;
  raise notice 'PASS 33.1: de ronde draait zonder gebruiker (% taken, % feestdagen)', v_taken, v_feestdagen;

  -- 33.2 De feestdagen gaan voor de taken. Zou dat andersom lopen, dan worden
  -- deadlines berekend tegen een kalender die de laatste jaren nog niet kent en
  -- verschuift de motor daar alleen op weekends -- precies de fout die een AV
  -- op Nieuwjaar 2029 zette.
  select count(*) into v_dekking from public.public_holidays
   where jaar = v_horizon and not ingetrokken;
  if v_dekking < 10 then
    raise exception 'FAIL 33.2: het horizonjaar % heeft maar % feestdagen', v_horizon, v_dekking;
  end if;
  select count(*) into v_n from public.task_instances ti
   where ti.client_id = v_klant and ti.status <> 'geannuleerd'
     and ti.due_date in (select datum from public.public_holidays where not ingetrokken);
  if v_n <> 0 then
    raise exception 'FAIL 33.2: % taken staan op een feestdag', v_n;
  end if;
  raise notice 'PASS 33.2: feestdagen eerst -- geen enkele taak op een feestdag';

  -- 33.3 Een tweede ronde voegt niets toe. Een onderhoudsjob die elke maand
  -- dubbels maakt is erger dan geen job.
  v_log := public.onderhoud_taken('test');
  select nieuwe_taken into v_taken from public.onderhoud_log where id = v_log;
  if v_taken <> 0 then
    raise exception 'FAIL 33.3: een tweede ronde leverde % nieuwe taken op i.p.v. 0', v_taken;
  end if;
  raise notice 'PASS 33.3: herhalen verandert niets';

  -- 33.4 Een mislukte ronde laat óók een spoor na, en werpt de fout door.
  -- Een lege ronde en een mislukte ronde zien er in een teller allebei uit als
  -- nul; zonder het foutveld zijn ze niet uit elkaar te houden.
  --
  -- We breken de ronde echt: een jaar feestdagen weghalen zodat er iets in te
  -- voegen valt, en dan het invoegen laten mislukken.
  delete from public.public_holidays where jaar = v_horizon + 3;
  create or replace function pg_temp.s33_breek() returns trigger language plpgsql as $t$
  begin
    raise exception 'S33 opzettelijke storing';
  end $t$;
  create trigger trg_s33_breek before insert on public.public_holidays
    for each row execute function pg_temp.s33_breek();

  -- De ronde werpt de fout bewust NIET door: dat zou de transactie terugdraaien
  -- en juist de logregel wissen die de mislukking vastlegt.
  perform public.onderhoud_taken('test-storing');
  drop trigger trg_s33_breek on public.public_holidays;

  select fout, geeindigd_op into v_fout, v_eind
    from public.onderhoud_log where aanleiding = 'test-storing'
   order by gestart_op desc limit 1;
  if v_fout is null then
    raise exception 'FAIL 33.4: de mislukte ronde liet geen fout na in het logboek';
  end if;
  if v_eind is null then
    raise exception 'FAIL 33.4: de mislukte ronde werd niet afgesloten in het logboek';
  end if;
  raise notice 'PASS 33.4: een mislukte ronde laat een spoor na (%)', left(v_fout, 40);

  -- 33.5 Het logboek is voor de kantoorbeheerder, niet voor iedereen, en het is
  -- door niemand te wijzigen -- ook niet door wie het mag lezen.
  perform set_config('taskflow.test_uid', v_uid2::text, true);
  set local role authenticated;
  select count(*) into v_n from public.onderhoud_log;
  set local role postgres;
  if v_n <> 0 then
    raise exception 'FAIL 33.5: een medewerker zag % logregels', v_n;
  end if;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  select count(*) into v_n from public.onderhoud_log;
  set local role postgres;
  if v_n = 0 then
    raise exception 'FAIL 33.5: de kantoorbeheerder ziet het logboek niet';
  end if;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  update public.onderhoud_log set nieuwe_taken = 999;
  get diagnostics v_n = row_count;
  set local role postgres;
  if v_n <> 0 then
    raise exception 'FAIL 33.5: het logboek was te wijzigen (% rijen)', v_n;
  end if;
  raise notice 'PASS 33.5: alleen de kantoorbeheerder leest het, niemand schrijft erin';

  -- 33.6 De ronde zelf is niet vanuit de app aan te roepen: ze loopt over alle
  -- kantoren heen. De kantoorbeheerder heeft generate_task_instances voor het
  -- eigen kantoor.
  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    perform public.onderhoud_taken('stiekem');
  exception when insufficient_privilege then v_ok := true;
  end;
  set local role postgres;
  if not v_ok then
    raise exception 'FAIL 33.6: het instance-brede onderhoud was vanuit de app te starten';
  end if;
  raise notice 'PASS 33.6: het onderhoud blijft buiten de app';
end $$;

-- ============================================================
-- Sectie 34 (0026): een gearchiveerde klant laat geen taken achter.
--
-- Het kantoor: "klanten archiveren. Als een klant dan wordt gearchiveerd
-- moeten de taken automatisch geannuleerd of ook gearchiveerd worden."
--
-- Tot 0025 sloeg de generatie een inactieve klant wel over (er kwamen geen
-- taken bij), maar ruimde niemand de taken op die er al stonden. Een
-- gearchiveerde klant verdween dus uit de klantenlijst terwijl zijn
-- openstaande taken in de werkstroomblokken bleven hangen -- bij honderd
-- dossiers precies het soort stille rommel waar dit systeem niet tegen kan.
--
-- Drie regels sturen deze sectie:
--   * "verwijderen bestaat niet" (0021): annuleren haalt de taak uit alle
--     lijsten en houdt hem in de geschiedenis;
--   * afgesloten werk blijft afgesloten: ingediend_afgerond en geannuleerd
--     worden niet aangeraakt;
--   * niets gebeurt in stilte: elke geannuleerde taak krijgt haar eigen
--     logregel, en het dossier houdt het aantal bij.
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid(); v_uid2 uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid; v_mw uuid;
  v_klant uuid; v_buur uuid;
  v_ot_rap uuid; v_ot_btw uuid;
  v_taak_lopend uuid; v_taak_klaar uuid; v_taak_wacht uuid; v_taak_geann uuid;
  v_afgerond_op timestamptz;
  v_te_annuleren int; v_n int; v_open int; v_geann int; v_log int; v_nieuw int;
  v_status public.task_status; v_notitie text; v_actor uuid;
  v_buur_open int;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_uid, 's34-admin@test.local', now()),
    (v_uid2, 's34-mw@test.local', now());
  insert into public.firms (naam) values ('Sectie 34 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S34 Beheerder', 's34-admin@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid2, 'S34 Medewerker', 's34-mw@test.local', 'medewerker', false, true)
    returning id into v_mw;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  select id into v_ot_rap from public.obligation_types where code = 'rapportering';
  select id into v_ot_btw from public.obligation_types where code = 'btw_aangifte';

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S34 Klant', 12, 31, 'periodieke_aangever', 'kwartaal', true)
    returning id into v_klant;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S34 Buurklant', 12, 31, 'periodieke_aangever', 'kwartaal', true)
    returning id into v_buur;

  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
    values (v_klant, v_ot_rap, true, current_date, v_mw), (v_buur, v_ot_rap, true, current_date, v_mw);

  perform set_config('taskflow.test_uid', v_uid2::text, true);
  set local role authenticated;
  perform public.sync_client_tasks(v_klant);
  perform public.sync_client_tasks(v_buur);
  set local role postgres;

  -- Een dossier zoals het er in het echt bijligt: iets in uitvoering, iets dat
  -- op de klant wacht, iets dat af is, en iets dat eerder al geannuleerd werd.
  select id into v_taak_lopend from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_rap order by due_date limit 1;
  select id into v_taak_klaar from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_rap and id <> v_taak_lopend
   order by due_date limit 1;
  select id into v_taak_wacht from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_btw order by due_date limit 1;
  select id into v_taak_geann from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_btw and id <> v_taak_wacht
   order by due_date desc limit 1;

  perform set_config('taskflow.test_uid', v_uid2::text, true);
  set local role authenticated;
  update public.task_instances set status = 'in_uitvoering' where id = v_taak_lopend;
  update public.task_instances set status = 'ingediend_afgerond' where id = v_taak_klaar;
  update public.task_instances set status = 'wacht_op_klant' where id = v_taak_wacht;
  update public.task_instances set status = 'geannuleerd' where id = v_taak_geann;
  set local role postgres;

  select afgerond_op into v_afgerond_op from public.task_instances where id = v_taak_klaar;
  select count(*) into v_te_annuleren from public.task_instances
   where client_id = v_klant and status not in ('ingediend_afgerond', 'geannuleerd');
  select count(*) into v_buur_open from public.task_instances
   where client_id = v_buur and status not in ('ingediend_afgerond', 'geannuleerd');
  select count(*) into v_log from public.task_status_log where task_instance_id = v_taak_geann;
  if v_te_annuleren < 2 then
    raise exception 'FAIL 34.0: fixture levert maar % openstaande taken op', v_te_annuleren;
  end if;

  -- 34.1 Archiveren annuleert alles wat nog open stond.
  perform set_config('taskflow.test_uid', v_uid2::text, true);
  set local role authenticated;
  update public.clients set actief = false where id = v_klant;
  set local role postgres;

  select count(*) into v_open from public.task_instances
   where client_id = v_klant and status not in ('ingediend_afgerond', 'geannuleerd');
  if v_open <> 0 then
    raise exception 'FAIL 34.1: % taken bleven openstaan na het archiveren van de klant', v_open;
  end if;
  select status into v_status from public.task_instances where id = v_taak_lopend;
  if v_status <> 'geannuleerd' then
    raise exception 'FAIL 34.1: een taak in uitvoering bleef op % staan', v_status;
  end if;
  raise notice 'PASS 34.1: archiveren annuleert de % openstaande taken', v_te_annuleren;

  -- 34.2 Wat af is blijft af, en wat al geannuleerd was wordt niet nog eens
  -- aangeraakt. enforce_task_instance_transition weigert die overgangen sowieso;
  -- de archivering mag er dus niet op stukvallen en er ook geen dubbele
  -- logregel voor schrijven.
  select status, afgerond_op into v_status, v_afgerond_op
    from public.task_instances where id = v_taak_klaar;
  if v_status <> 'ingediend_afgerond' or v_afgerond_op is null then
    raise exception 'FAIL 34.2: de afgeronde taak werd aangeraakt (status %, afgerond_op %)', v_status, v_afgerond_op;
  end if;
  select count(*) into v_n from public.task_status_log where task_instance_id = v_taak_geann;
  if v_n <> v_log then
    raise exception 'FAIL 34.2: de eerder geannuleerde taak kreeg % extra logregels', v_n - v_log;
  end if;
  raise notice 'PASS 34.2: afgesloten werk blijft ongemoeid';

  -- 34.3 De buurklant merkt er niets van.
  select count(*) into v_n from public.task_instances
   where client_id = v_buur and status not in ('ingediend_afgerond', 'geannuleerd');
  if v_n <> v_buur_open then
    raise exception 'FAIL 34.3: de buurklant ging van % naar % openstaande taken', v_buur_open, v_n;
  end if;
  raise notice 'PASS 34.3: alleen het gearchiveerde dossier wordt geraakt';

  -- 34.4 Niets gebeurt in stilte. Elke geannuleerde taak heeft haar eigen
  -- statusregel, op naam van wie archiveerde, en die regel zegt waarom.
  -- created_at is now(), en dat is binnen een transactie voor alle regels
  -- dezelfde waarde -- sorteren zegt hier dus niets. Filter op de overgang zelf.
  select nieuw_status, notitie, actor_employee_id into v_status, v_notitie, v_actor
    from public.task_status_log
   where task_instance_id = v_taak_lopend and event_type = 'status_wijziging'
     and oud_status = 'in_uitvoering' and nieuw_status = 'geannuleerd';
  if v_status is distinct from 'geannuleerd' then
    raise exception 'FAIL 34.4: geen statusregel voor de geannuleerde taak';
  end if;
  if v_actor <> v_mw then
    raise exception 'FAIL 34.4: de logregel staat op naam van % i.p.v. wie archiveerde', v_actor;
  end if;
  if v_notitie is null or v_notitie not ilike '%gearchiveerd%' then
    raise exception 'FAIL 34.4: de logregel zegt niet dat de klant gearchiveerd werd (%)', coalesce(v_notitie, 'leeg');
  end if;
  select count(*) into v_n from public.task_status_log l
    join public.task_instances ti on ti.id = l.task_instance_id
   where ti.client_id = v_klant and l.event_type = 'status_wijziging'
     and l.nieuw_status = 'geannuleerd' and l.notitie ilike '%gearchiveerd%';
  if v_n <> v_te_annuleren then
    raise exception 'FAIL 34.4: % logregels voor % geannuleerde taken', v_n, v_te_annuleren;
  end if;
  raise notice 'PASS 34.4: elke annulering staat in task_status_log (% regels)', v_n;

  -- 34.5 Het dossier houdt het aantal bij. Een klant archiveren die zestig
  -- taken annuleert hoort in de wijzigingshistoriek van dat dossier te staan,
  -- niet alleen verspreid over zestig taken.
  select count(*) into v_n from public.client_change_log
   where client_id = v_klant and veld = 'actief' and nieuwe_waarde = 'false';
  if v_n <> 1 then
    raise exception 'FAIL 34.5: het archiveren zelf staat % keer in de historiek', v_n;
  end if;
  select nieuwe_waarde into v_notitie from public.client_change_log
   where client_id = v_klant and veld = 'taken_geannuleerd_bij_archivering'
   order by created_at desc limit 1;
  if v_notitie is distinct from v_te_annuleren::text then
    raise exception 'FAIL 34.5: de historiek meldt % geannuleerde taken i.p.v. %',
      coalesce(v_notitie, 'niets'), v_te_annuleren;
  end if;
  raise notice 'PASS 34.5: de wijzigingshistoriek noemt het aantal (%)', v_te_annuleren;

  -- 34.6 Een gearchiveerde klant krijgt geen nieuwe taken, ook niet wanneer er
  -- toevallig nog een ronde over het dossier loopt.
  perform set_config('taskflow.test_uid', v_uid2::text, true);
  set local role authenticated;
  v_nieuw := public.sync_client_tasks(v_klant);
  set local role postgres;
  if v_nieuw <> 0 then
    raise exception 'FAIL 34.6: een gearchiveerde klant kreeg % nieuwe taken', v_nieuw;
  end if;
  select count(*) into v_open from public.task_instances
   where client_id = v_klant and status not in ('ingediend_afgerond', 'geannuleerd');
  if v_open <> 0 then
    raise exception 'FAIL 34.6: er stonden na de ronde weer % taken open', v_open;
  end if;
  raise notice 'PASS 34.6: een gearchiveerd dossier blijft leeg';

  -- 34.7 Een tweede wijziging aan een al gearchiveerde klant doet niets: de
  -- trigger vuurt alleen op de overgang actief -> niet actief.
  select count(*) into v_log from public.client_change_log
   where client_id = v_klant and veld = 'taken_geannuleerd_bij_archivering';
  perform set_config('taskflow.test_uid', v_uid2::text, true);
  set local role authenticated;
  update public.clients set naam = 'S34 Klant (gearchiveerd)' where id = v_klant;
  update public.clients set actief = false where id = v_klant;
  set local role postgres;
  select count(*) into v_n from public.client_change_log
   where client_id = v_klant and veld = 'taken_geannuleerd_bij_archivering';
  if v_n <> v_log then
    raise exception 'FAIL 34.7: de archivering vuurde opnieuw (% i.p.v. % regels)', v_n, v_log;
  end if;
  raise notice 'PASS 34.7: de trigger vuurt alleen op de overgang naar gearchiveerd';

  -- 34.8 Het omgekeerde: een klant die weer actief wordt. De geannuleerde
  -- taken komen niet terug -- dat hoort ook niet -- maar de generator maakt bij
  -- de volgende ronde nieuwe aan voor de verplichtingen die nog lopen, zonder
  -- een tweede actieve taak voor dezelfde periode.
  select count(*) into v_geann from public.task_instances
   where client_id = v_klant and status = 'geannuleerd';
  perform set_config('taskflow.test_uid', v_uid2::text, true);
  set local role authenticated;
  update public.clients set actief = true where id = v_klant;
  v_nieuw := public.sync_client_tasks(v_klant);
  set local role postgres;
  if v_nieuw <= 0 then
    raise exception 'FAIL 34.8: een heractiveerde klant kreeg geen nieuwe taken (%)', v_nieuw;
  end if;
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and status = 'geannuleerd';
  if v_n <> v_geann then
    raise exception 'FAIL 34.8: er kwamen geannuleerde taken terug (% i.p.v. %)', v_n, v_geann;
  end if;
  select count(*) into v_n from (
    select client_id, obligation_type_id, periode_label
      from public.task_instances
     where client_id = v_klant and status <> 'geannuleerd'
       and bron_type = 'automatisch_gegenereerd'
     group by 1, 2, 3 having count(*) > 1
  ) d;
  if v_n <> 0 then
    raise exception 'FAIL 34.8: % periodes kregen een dubbele actieve taak', v_n;
  end if;
  raise notice 'PASS 34.8: heractiveren levert nieuwe taken op (%), geen dubbels, geen herrijzenis', v_nieuw;
end $$;


-- ============================================================
-- Sectie 35 (0027/0028): de fiches 281.20, 281.45 en 281.50.
--
-- Het kantoor: "ik heb nog extra taken gevonden die we moeten aanvullen.
-- Fiches 281.20 - 281.45 - 281.50."
--
-- Twee dingen moeten hier vastliggen, want ze zijn allebei onzichtbaar fout
-- te krijgen:
--
--   * de fiches lopen op het INKOMSTENJAAR en niet op het boekjaar. Een
--     vennootschap met een boekjaar tot 30 juni dient haar fiches nog altijd
--     per kalenderjaar in. Wie dit aan het boekjaar hangt, krijgt voor elk
--     niet-kalenderdossier een deadline die er plausibel uitziet en fout is.
--   * "eind februari" is de 29e in een schrikkeljaar. Een vaste 28 zou drie
--     jaar op vier kloppen -- precies het soort fout dat pas in 2028 opvalt.
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid;
  v_dec uuid; v_juni uuid;
  v_ot_20 uuid; v_ot_45 uuid; v_ot_50 uuid;
  v_n int; v_d date;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's35@test.local', now());
  insert into public.firms (naam) values ('Sectie 35 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S35 Beheerder', 's35@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  select id into v_ot_20 from public.obligation_types where code = 'fiche_281_20';
  select id into v_ot_45 from public.obligation_types where code = 'fiche_281_45';
  select id into v_ot_50 from public.obligation_types where code = 'fiche_281_50';

  if v_ot_20 is null or v_ot_45 is null or v_ot_50 is null then
    raise exception 'FAIL 35.0: de drie fiches staan niet in de catalogus';
  end if;

  -- 35.1 Ze horen in hun eigen werkstroom, niet tussen de afsluitingstaken.
  select count(*) into v_n from public.obligation_types
   where code like 'fiche_281_%' and werkstroom = 'fiches';
  if v_n <> 3 then
    raise exception 'FAIL 35.1: % van de 3 fiches staan in de werkstroom fiches', v_n;
  end if;
  raise notice 'PASS 35.1: de drie fiches staan in hun eigen werkstroom';

  -- Twee dossiers met een verschillend boekjaar, verder identiek.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S35 December', 12, 31, 'geen', true) returning id into v_dec;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S35 Juni', 6, 30, 'geen', true) returning id into v_juni;

  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_dec, v_ot_20, true, current_date),
           (v_dec, v_ot_45, true, current_date),
           (v_dec, v_ot_50, true, current_date),
           (v_juni, v_ot_20, true, current_date),
           (v_juni, v_ot_50, true, current_date);

  perform public.generate_task_instances_intern(v_firm, 36, 0, null);

  -- 35.2 Het boekjaar doet er niet toe: dezelfde deadlines voor beide klanten.
  select count(*) into v_n
  from public.task_instances a
  join public.task_instances b
    on b.client_id = v_juni and b.obligation_type_id = a.obligation_type_id
   and b.periode_label = a.periode_label
  where a.client_id = v_dec
    and a.obligation_type_id in (v_ot_20, v_ot_50)
    and a.due_date_wettelijk <> b.due_date_wettelijk;
  if v_n <> 0 then
    raise exception 'FAIL 35.2: % fiche-taken kregen een andere datum door het boekjaar', v_n;
  end if;
  raise notice 'PASS 35.2: de fiches volgen het inkomstenjaar, niet het boekjaar';

  -- 35.3 De periode is het kalenderjaar.
  select count(*) into v_n from public.task_instances
   where client_id = v_dec and obligation_type_id in (v_ot_20, v_ot_45, v_ot_50)
     and (extract(month from periode_start) <> 1 or extract(day from periode_start) <> 1
       or extract(month from periode_eind) <> 12 or extract(day from periode_eind) <> 31);
  if v_n <> 0 then
    raise exception 'FAIL 35.3: % fiche-taken hebben geen kalenderjaar als periode', v_n;
  end if;
  raise notice 'PASS 35.3: elke fiche-taak loopt van 1 januari tot 31 december';

  -- 35.4 281.20 en 281.45: eind februari van het jaar erna.
  select count(*) into v_n from public.task_instances
   where client_id = v_dec and obligation_type_id in (v_ot_20, v_ot_45)
     and due_date_wettelijk <> (make_date(periode_label::int + 1, 3, 1) - 1);
  if v_n <> 0 then
    raise exception 'FAIL 35.4: % taken van 281.20/281.45 staan niet op eind februari', v_n;
  end if;
  raise notice 'PASS 35.4: 281.20 en 281.45 vallen eind februari van het jaar erna';

  -- 35.5 En dan de 29e in een schrikkeljaar. Inkomstenjaar 2027 -> 29/02/2028.
  select due_date_wettelijk into v_d from public.task_instances
   where client_id = v_dec and obligation_type_id = v_ot_20 and periode_label = '2027';
  if v_d is not null and v_d <> date '2028-02-29' then
    raise exception 'FAIL 35.5: inkomstenjaar 2027 kreeg % in plaats van 29/02/2028', v_d;
  end if;
  raise notice 'PASS 35.5: een schrikkeljaar levert de 29e op (%)', coalesce(v_d::text, 'buiten het venster');

  -- 35.6 281.50: 29 juni van het jaar erna.
  --
  -- Stond hier tot 04/09/2026 als 30 juni. Dat was fout, en de test hield de
  -- fout in stand: de wet zegt "vóór 30 juni", dus ten laatste de 29ste, en
  -- de FOD kondigde inkomstenjaar 2025 aan als "uiterlijk op maandag 29 juni
  -- 2026". Gecorrigeerd in migratie 0049.
  select count(*) into v_n from public.task_instances
   where client_id = v_dec and obligation_type_id = v_ot_50
     and due_date_wettelijk <> make_date(periode_label::int + 1, 6, 29);
  if v_n <> 0 then
    raise exception 'FAIL 35.6: % taken van 281.50 staan niet op 29 juni', v_n;
  end if;
  raise notice 'PASS 35.6: 281.50 valt op 29 juni van het jaar erna';

  -- 35.7 Wie de fiche niet aangevinkt heeft, krijgt er ook geen taak voor.
  select count(*) into v_n from public.task_instances
   where client_id = v_juni and obligation_type_id = v_ot_45;
  if v_n <> 0 then
    raise exception 'FAIL 35.7: er kwamen % taken voor een niet-aangevinkte fiche', v_n;
  end if;
  raise notice 'PASS 35.7: een niet-aangevinkte fiche levert geen taken op';

  -- 35.8 Herhalen verandert niets.
  select count(*) into v_n from public.task_instances
   where client_id in (v_dec, v_juni) and obligation_type_id in (v_ot_20, v_ot_45, v_ot_50);
  perform public.generate_task_instances_intern(v_firm, 36, 0, null);
  if (select count(*) from public.task_instances
       where client_id in (v_dec, v_juni) and obligation_type_id in (v_ot_20, v_ot_45, v_ot_50)) <> v_n then
    raise exception 'FAIL 35.8: een tweede ronde maakte extra fiche-taken aan';
  end if;
  raise notice 'PASS 35.8: een tweede ronde levert geen dubbele fiche-taken op (% taken)', v_n;
end $$;

-- ============================================================
-- Sectie 36 (0029/0030): de jaarafsluiting vóór de algemene vergadering.
--
-- Het kantoor: "kan je de jaarafsluiting instellen dat dit een maand voor de
-- algemene vergadering kan zijn, tweede optie. kan ook eventueel vroeger door
-- een maand aan te duiden."
--
-- De aanleiding is concreet: bij een dossier met boekjaareinde 31/12 en een AV
-- op 29 maart gaf de oude vaste doorlooptijd van drie maanden 31 maart -- twee
-- dagen ná de vergadering waar de boeken goedgekeurd worden.
--
-- Het lastige zit niet in de berekening maar in wat eromheen hangt:
--   * bestaande dossiers mogen niet verschuiven zolang niemand iets kiest;
--   * een taak die er al staat moet wél mee verschuiven zodra iemand kiest --
--     anders staat de instelling er en volgt de kalender niet;
--   * de AV-datum en de jaarafsluiting mogen nooit uit elkaar lopen;
--   * een handmatig afgesproken deadline wordt nooit stil overschreven.
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid; v_klant uuid;
  v_ot_ja uuid; v_ot_av uuid;
  v_co_ja uuid; v_co_av uuid;
  v_taak uuid; v_be date;
  v_oud date; v_nieuw date; v_av date; v_n int;
  v_review boolean; v_reden text;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's36@test.local', now());
  insert into public.firms (naam) values ('Sectie 36 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S36 Beheerder', 's36@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  select id into v_ot_ja from public.obligation_types where code = 'jaarafsluiting';
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S36 Klant', 12, 31, 'geen', true) returning id into v_klant;

  -- Een dossier zoals het er vandaag bijligt: alleen sla_maanden, geen basis.
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters)
    values (v_klant, v_ot_ja, true, current_date, '{"sla_maanden": 3}'::jsonb)
    returning id into v_co_ja;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters)
    values (v_klant, v_ot_av, true, current_date, '{"av_vorm":"vaste_datum","av_maand":5,"av_dag":15}'::jsonb)
    returning id into v_co_av;

  perform public.generate_task_instances_intern(v_firm, 36, 0, null);

  -- 36.1 Zonder basis blijft alles zoals het was: boekjaareinde + sla_maanden.
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_ja
     and due_date_wettelijk <> (periode_eind + interval '3 months')::date;
  if v_n <> 0 then
    raise exception 'FAIL 36.1: % taken verschoven terwijl er niets gekozen was', v_n;
  end if;
  raise notice 'PASS 36.1: een dossier zonder basis houdt zijn oude deadline';

  select id, periode_eind, due_date_wettelijk into v_taak, v_be, v_oud
  from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_ja and due_date >= current_date
   order by due_date limit 1;

  -- 36.2 Kiezen voor "een maand voor de AV" verzet de taak die er al staat.
  --      Dit was het gat na 0029: upsert_generated_task laat een bestaande taak
  --      met rust, dus zonder de herberekening van 0030 gebeurde er niets.
  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  update public.client_obligations
     set parameters = '{"basis":"voor_av","maanden_voor_av":1}'::jsonb
   where id = v_co_ja;
  set local role postgres;

  select due_date_wettelijk into v_nieuw from public.task_instances where id = v_taak;
  v_av := public.av_datum(v_be, '{"av_vorm":"vaste_datum","av_maand":5,"av_dag":15}'::jsonb);
  if v_nieuw <> (v_av - interval '1 month')::date then
    raise exception 'FAIL 36.2: de taak staat op % en niet op % (AV %)',
      v_nieuw, (v_av - interval '1 month')::date, v_av;
  end if;
  if v_nieuw = v_oud then
    raise exception 'FAIL 36.2: de deadline is helemaal niet verschoven (%)', v_oud;
  end if;
  raise notice 'PASS 36.2: de bestaande taak schoof van % naar % (AV %)', v_oud, v_nieuw, v_av;

  -- 36.3 En de verschuiving staat in de historiek: niets gebeurt in stilte.
  select count(*) into v_n from public.task_status_log
   where task_instance_id = v_taak and event_type = 'due_date_herberekend';
  if v_n = 0 then
    raise exception 'FAIL 36.3: de verschoven deadline liet geen logregel na';
  end if;
  select count(*) into v_n from public.client_change_log
   where client_id = v_klant and veld = 'jaarafsluiting_berekening';
  if v_n = 0 then
    raise exception 'FAIL 36.3: de wijziging staat niet in de historiek van het dossier';
  end if;
  raise notice 'PASS 36.3: de verschuiving staat in het takenlog en in het dossier';

  -- 36.4 De AV verzetten trekt de jaarafsluiting mee. Zonder deze weg zou de
  --      vergadering opschuiven en de afsluiting blijven staan -- en dan wijst
  --      "een maand voor de AV" naar een vergadering die er niet meer is.
  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  update public.client_obligations
     set parameters = '{"av_vorm":"vaste_datum","av_maand":6,"av_dag":10}'::jsonb
   where id = v_co_av;
  set local role postgres;

  select due_date_wettelijk into v_nieuw from public.task_instances where id = v_taak;
  if v_nieuw <> (make_date(extract(year from v_be)::int + 1, 6, 10) - interval '1 month')::date then
    raise exception 'FAIL 36.4: de jaarafsluiting volgde de verplaatste AV niet (%)', v_nieuw;
  end if;
  raise notice 'PASS 36.4: de AV verzetten trekt de jaarafsluiting mee naar %', v_nieuw;

  -- 36.5 Nooit vóór het boekjaareinde. Je kunt de boeken van een jaar niet
  --      afsluiten voor dat jaar voorbij is.
  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  update public.client_obligations
     set parameters = '{"basis":"voor_av","maanden_voor_av":6}'::jsonb
   where id = v_co_ja;
  set local role postgres;

  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_ja
     and due_date >= current_date and due_date_wettelijk < periode_eind;
  if v_n <> 0 then
    raise exception 'FAIL 36.5: % taken staan voor hun eigen boekjaareinde', v_n;
  end if;
  raise notice 'PASS 36.5: geen enkele afsluiting valt voor het boekjaareinde';

  -- 36.6 Een handmatig afgesproken deadline wordt niet stil overschreven.
  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  update public.task_instances set due_date = due_date + 5 where id = v_taak;
  set local role postgres;
  select due_date into v_oud from public.task_instances where id = v_taak;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  update public.client_obligations
     set parameters = '{"basis":"voor_av","maanden_voor_av":2}'::jsonb
   where id = v_co_ja;
  set local role postgres;

  select due_date, review_vereist, review_reden into v_nieuw, v_review, v_reden
  from public.task_instances where id = v_taak;
  if v_nieuw <> v_oud then
    raise exception 'FAIL 36.6: de handmatige afspraak werd overschreven (% -> %)', v_oud, v_nieuw;
  end if;
  if not v_review then
    raise exception 'FAIL 36.6: de handmatige afspraak bleef staan zonder review';
  end if;
  raise notice 'PASS 36.6: een handmatige deadline blijft staan (%) en krijgt een review', v_nieuw;

  -- 36.7 De parameters worden afgegrensd. Zonder deze controle levert een
  --      typefout een deadline op die plausibel oogt en nergens op slaat.
  begin
    perform set_config('taskflow.test_uid', v_uid::text, true);
    set local role authenticated;
    update public.client_obligations set parameters = '{"basis":"voor-av","maanden_voor_av":1}'::jsonb
     where id = v_co_ja;
    set local role postgres;
    raise exception 'FAIL 36.7: een onbekende basis werd aanvaard';
  exception when check_violation then
    set local role postgres;
  end;
  begin
    perform set_config('taskflow.test_uid', v_uid::text, true);
    set local role authenticated;
    update public.client_obligations set parameters = '{"basis":"voor_av","maanden_voor_av":9}'::jsonb
     where id = v_co_ja;
    set local role postgres;
    raise exception 'FAIL 36.7: negen maanden voor de AV werd aanvaard';
  exception when check_violation then
    set local role postgres;
  end;
  begin
    perform set_config('taskflow.test_uid', v_uid::text, true);
    set local role authenticated;
    update public.client_obligations set parameters = '{"basis":"voor_av"}'::jsonb
     where id = v_co_ja;
    set local role postgres;
    raise exception 'FAIL 36.7: een ontbrekend aantal maanden werd aanvaard';
  exception when check_violation then
    set local role postgres;
  end;
  raise notice 'PASS 36.7: een onbekende basis en een aantal buiten 1-6 worden geweigerd';
end $$;

-- ============================================================
-- Sectie 37 (0031): de neerlegging wordt niet elke ronde opnieuw geannuleerd.
--
-- Gevonden bij het nakijken van de Excel-import. neerlegging_jaarrekening
-- heeft geen eigen tak in de generator: die taken worden aangemaakt vanuit de
-- AV-tak, als vervolgtaak met voorloper_taak_id naar de vergadering. Maar de
-- opruimstap van sync_client_tasks() oordeelde puur op "bestaat er een lopende
-- client_obligation voor dit verplichtingstype?".
--
-- Gevolg bij een klant die wel een AV heeft en geen aangevinkte neerlegging --
-- en dat is precies wat de import oplevert: elke ronde annuleerde de
-- neerleggingstaken, en de AV-tak maakte er meteen nieuwe aan. Gemeten op
-- productie: 3 open / 0 geannuleerd, dan 3/3, dan 3/6. Dat groeit door bij elk
-- opslaan en bij elke maandelijkse onderhoudsronde.
--
-- De regel die dit oplost: een taak met een voorloper wordt bestuurd door die
-- voorloper. Ze verdwijnt pas wanneer de vergadering zelf weg is -- dan is er
-- ook echt niets meer na te leggen.
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid; v_klant uuid;
  v_ot_av uuid; v_ot_nbb uuid; v_co_av uuid;
  v_open int; v_geann int; v_open2 int; v_geann2 int;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's37@test.local', now());
  insert into public.firms (naam) values ('Sectie 37 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S37 Beheerder', 's37@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';
  select id into v_ot_nbb from public.obligation_types where code = 'neerlegging_jaarrekening';

  -- Een klant zoals de import hem aanmaakt: wel een AV, geen aangevinkte
  -- neerlegging. De neerleggingstaken komen mee met de vergadering.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S37 Klant', 12, 31, 'geen', true) returning id into v_klant;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_klant, v_ot_av, true, current_date) returning id into v_co_av;

  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  perform public.sync_client_tasks(v_klant);
  set local role postgres;

  select count(*) filter (where status = 'open'),
         count(*) filter (where status = 'geannuleerd')
    into v_open, v_geann
  from public.task_instances where client_id = v_klant and obligation_type_id = v_ot_nbb;

  if v_open = 0 then
    raise exception 'FAIL 37.0: de AV leverde geen neerleggingstaken op';
  end if;

  -- 37.1 Drie rondes na elkaar veranderen niets. Dit is de eigenlijke
  --      regressie: voorheen kwamen er per ronde net zoveel geannuleerde
  --      taken bij als er open stonden.
  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  perform public.sync_client_tasks(v_klant);
  perform public.sync_client_tasks(v_klant);
  perform public.sync_client_tasks(v_klant);
  set local role postgres;

  select count(*) filter (where status = 'open'),
         count(*) filter (where status = 'geannuleerd')
    into v_open2, v_geann2
  from public.task_instances where client_id = v_klant and obligation_type_id = v_ot_nbb;

  if v_open2 <> v_open or v_geann2 <> v_geann then
    raise exception
      'FAIL 37.1: drie rondes veranderden de neerleggingstaken van %/% naar %/% (open/geannuleerd)',
      v_open, v_geann, v_open2, v_geann2;
  end if;
  raise notice 'PASS 37.1: herhaalde rondes laten de % neerleggingstaken met rust', v_open;

  -- 37.2 Maar gaat de vergadering zelf eruit, dan moet de neerlegging mee.
  --      Anders blijft er een taak staan voor een AV die niet meer bestaat.
  perform set_config('taskflow.test_uid', v_uid::text, true);
  set local role authenticated;
  update public.client_obligations set actief = false, geldig_tot = current_date where id = v_co_av;
  perform public.sync_client_tasks(v_klant);
  perform public.sync_client_tasks(v_klant);
  set local role postgres;

  select count(*) filter (where status = 'open') into v_open2
  from public.task_instances where client_id = v_klant and obligation_type_id = v_ot_nbb
   and due_date >= current_date;
  if v_open2 <> 0 then
    raise exception 'FAIL 37.2: er bleven % neerleggingstaken open na het afzetten van de AV', v_open2;
  end if;
  raise notice 'PASS 37.2: zonder algemene vergadering blijft er geen neerlegging open staan';
end $$;


-- ============================================================
-- Sectie 38 (0032): geen functie staat per ongeluk open via de API.
--
-- Gevonden bij de securityronde. Supabase zet elke functie in het schema
-- `public` automatisch open op /rest/v1/rpc. "Geen revoke geschreven" betekent
-- daar dus niet "intern", maar "voor iedereen aanroepbaar". In 0029 en 0030
-- was die revoke vergeten, en één van die functies --
-- herbereken_jaarafsluiting_taken_voor() -- is SECURITY DEFINER, neemt een
-- willekeurige client_id en verzette wettelijke deadlines. Nagespeeld op
-- productie: een gewone medewerker verzette er in één aanroep drie, voor een
-- dossier waar can_access_client() niet eens aan te pas kwam.
--
-- Deze sectie bewaakt de regel in plaats van het ene geval: een functie die
-- een trigger teruggeeft hoort nooit rechtstreeks aanroepbaar te zijn, en
-- interne SECURITY DEFINER-functies die schrijven ook niet. Zo valt de
-- volgende vergeten revoke om op een test in plaats van op een linter die
-- niemand leest.
-- ============================================================
do $$
declare
  v_open text;
  v_n int;
begin
  -- 38.1 Geen enkele triggerfunctie is aanroepbaar door anon of authenticated.
  select string_agg(p.proname, ', ' order by p.proname), count(*)
    into v_open, v_n
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prorettype = 'trigger'::regtype
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if v_n > 0 then
    raise exception 'FAIL 38.1: % triggerfunctie(s) staan open via de API: %', v_n, v_open;
  end if;
  raise notice 'PASS 38.1: geen enkele triggerfunctie is via de API aanroepbaar';

  -- 38.2 De interne motorfuncties evenmin. Ze schrijven allemaal taken of
  --      deadlines; wat de app nodig heeft loopt via sync_client_tasks() en
  --      generate_task_instances(), en die controleren zelf de toegang.
  select string_agg(naam, ', ' order by naam), count(*) into v_open, v_n
  from (
    select p.proname as naam
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('generate_task_instances_intern', 'herbereken_jaarafsluiting_taken_voor',
                        'upsert_generated_task')
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) x;
  if v_n > 0 then
    raise exception 'FAIL 38.2: % interne motorfunctie(s) staan open via de API: %', v_n, v_open;
  end if;
  raise notice 'PASS 38.2: de interne motorfuncties zijn niet via de API aanroepbaar';

  -- 38.3 Elke SECURITY DEFINER-functie heeft een vaste search_path. Zonder die
  --      vaste waarde bepaalt de aanroeper welke tabellen de functie ziet.
  select string_agg(p.proname, ', ' order by p.proname), count(*)
    into v_open, v_n
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'
    );
  if v_n > 0 then
    raise exception 'FAIL 38.3: % SECURITY DEFINER-functie(s) zonder vaste search_path: %', v_n, v_open;
  end if;
  raise notice 'PASS 38.3: elke SECURITY DEFINER-functie heeft een vaste search_path';

  -- 38.4 En de functie die dit aan het licht bracht, controleert nu ook zelf
  --      de toegang -- twee sloten, want de revoke alleen sluit dit gat wel,
  --      maar een volgende aanroeper binnen de databank zou er anders zo langs.
  if position('can_access_client' in (
    select pg_get_functiondef(oid) from pg_proc
     where proname = 'herbereken_jaarafsluiting_taken_voor'
  )) = 0 then
    raise exception 'FAIL 38.4: herbereken_jaarafsluiting_taken_voor() controleert de toegang niet';
  end if;
  raise notice 'PASS 38.4: de herberekening controleert zelf of je het dossier mag zien';
end $$;


-- ============================================================
-- Sectie 39 (0033): de aangiftetermijn, met de winteruitzondering.
--
-- De motor rekende sinds 0019 met "de laatste dag van de zevende maand na het
-- boekjaareinde" en niets meer. Die regel is onvolledig: sluit het boekjaar af
-- tussen 31 december en eind februari, dan is de uiterste datum 30 september
-- (art. 310 WIB92). Bij een boekjaar op 31/12 -- de meest voorkomende
-- afsluitdatum -- stond de aangifte dus twee maanden te vroeg.
--
-- Te vroeg is de veilige kant, maar het is stil: er verschijnt geen fout, de
-- datum ziet er alleen maar plausibel uit. Precies waarom dit een test
-- verdient en geen opmerking in de code.
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid; v_ot uuid;
  v_klant uuid; v_n int; v_d date;
  r record;
begin
  -- 39.1 De regel zelf, per afsluitdatum.
  for r in
    select * from (values
      (date '2026-12-31', date '2027-09-30', 'winter: 31 december'),
      (date '2027-01-31', date '2027-09-30', 'winter: januari'),
      (date '2027-02-28', date '2027-09-30', 'winter: februari'),
      (date '2028-02-29', date '2028-09-30', 'winter: schrikkeljaar'),
      (date '2027-03-31', date '2027-10-31', 'gewoon: maart'),
      (date '2027-06-30', date '2028-01-31', 'gewoon: juni'),
      (date '2027-09-30', date '2028-04-30', 'gewoon: september'),
      (date '2027-12-15', date '2028-07-31', 'december, maar niet de 31e')
    ) t(be, verwacht, uitleg)
  loop
    if public.aangifte_deadline(r.be) <> r.verwacht then
      raise exception 'FAIL 39.1 (%): boekjaareinde % gaf % in plaats van %',
        r.uitleg, r.be, public.aangifte_deadline(r.be), r.verwacht;
    end if;
  end loop;
  raise notice 'PASS 39.1: de aangiftetermijn klopt voor elke afsluitdatum, ook 29 februari';

  -- 39.2 En de motor gebruikt diezelfde functie, niet een eigen kopie.
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's39@test.local', now());
  insert into public.firms (naam) values ('Sectie 39 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S39 Beheerder', 's39@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_uid::text, true);
  select id into v_ot from public.obligation_types where code = 'aangifte_venb_pb';

  -- Een boekjaar op 31 JANUARI: ook een winterafsluiting, en een cohort waar
  -- geen enkele andere sectie een campagnedatum voor invult. Sectie 27 zet er
  -- wel een voor het 31/12-cohort, en dan zou deze test de override meten in
  -- plaats van de formule.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S39 Januari', 1, 31, 'geen', true) returning id into v_klant;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_klant, v_ot, true, current_date);

  select count(*) into v_n from public.legal_calendar
   where obligation_type_id = v_ot and scope = 'boekjaar_1';
  if v_n <> 0 then
    raise exception 'FAIL 39.2: er staat een campagnedatum voor dit cohort; de test bewijst dan niets';
  end if;

  perform public.generate_task_instances_intern(v_firm, 36, 0, null);

  select count(*) into v_n from public.task_instances ti
   where ti.client_id = v_klant and ti.obligation_type_id = v_ot
     and ti.due_date_wettelijk <> public.aangifte_deadline(ti.periode_eind);
  if v_n <> 0 then
    raise exception 'FAIL 39.2: % aangiftetaken wijken af van de termijnfunctie', v_n;
  end if;

  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot;
  if v_n = 0 then
    raise exception 'FAIL 39.2: er kwamen helemaal geen aangiftetaken';
  end if;

  select due_date_wettelijk into v_d from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot order by due_date limit 1;
  if extract(month from v_d) <> 9 or extract(day from v_d) <> 30 then
    raise exception 'FAIL 39.2: een boekjaar op 31/01 gaf % in plaats van 30 september', v_d;
  end if;
  raise notice 'PASS 39.2: de motor volgt de termijnfunctie; een winterafsluiting levert 30 september (%)', v_d;
end $$;

-- ============================================================
-- Sectie 40 (0034/0035): de aangifte RPB, en wat er niet naast kan.
--
-- Een dossier valt onder de vennootschapsbelasting óf onder de
-- rechtspersonenbelasting, nooit onder allebei. De rechtsvorm zegt daar niets
-- over: ook een VZW kan onderworpen zijn aan de vennootschapsbelasting.
--
-- Daarom een slot en geen afleiding uit de rechtsvorm. Een dossier met twee
-- aangiftes ziet er op het scherm volkomen normaal uit, en je merkt het pas
-- als er twee keer een deadline aankomt.
--
-- Sinds 0035 geldt hetzelfde voor de voorafbetalingen: die horen bij de
-- vennootschapsbelasting en niet bij de rechtspersonenbelasting.
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid;
  v_ot_rpb uuid; v_ot_venb uuid; v_ot_va uuid;
  v_vzw uuid; v_bv uuid;
  v_n int; v_d date; v_geweigerd boolean := false;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's40@test.local', now());
  insert into public.firms (naam) values ('Sectie 40 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S40 Beheerder', 's40@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_uid::text, true);

  select id into v_ot_rpb from public.obligation_types where code = 'aangifte_rpb';
  select id into v_ot_venb from public.obligation_types where code = 'aangifte_venb_pb';
  if v_ot_rpb is null then
    raise exception 'FAIL 40.0: de aangifte RPB staat niet in de catalogus';
  end if;

  -- 40.1 De RPB volgt dezelfde termijn als de VenB.
  insert into public.clients (firm_id, naam, rechtsvorm, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S40 VZW', 'VZW', 12, 31, 'geen', true) returning id into v_vzw;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_vzw, v_ot_rpb, true, current_date);

  perform public.generate_task_instances_intern(v_firm, 36, 0, null);

  select count(*) into v_n from public.task_instances
   where client_id = v_vzw and obligation_type_id = v_ot_rpb;
  if v_n = 0 then
    raise exception 'FAIL 40.1: de RPB leverde geen taken op';
  end if;
  select count(*) into v_n from public.task_instances ti
   where ti.client_id = v_vzw and ti.obligation_type_id = v_ot_rpb
     and ti.due_date_wettelijk <> public.aangifte_deadline(ti.periode_eind);
  if v_n <> 0 then
    raise exception 'FAIL 40.1: % RPB-taken volgen de termijnfunctie niet', v_n;
  end if;
  select due_date_wettelijk into v_d from public.task_instances
   where client_id = v_vzw and obligation_type_id = v_ot_rpb order by due_date limit 1;
  raise notice 'PASS 40.1: de RPB volgt dezelfde termijn als de VenB (%)', v_d;

  -- 40.2 Het slot: er geen tweede aangifte bij kunnen zetten.
  begin
    insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
      values (v_vzw, v_ot_venb, true, current_date);
  exception when check_violation then
    v_geweigerd := true;
  end;
  if not v_geweigerd then
    raise exception 'FAIL 40.2: een dossier kreeg zowel de VenB- als de RPB-aangifte';
  end if;
  raise notice 'PASS 40.2: een tweede aangifte op hetzelfde dossier wordt geweigerd';

  -- 40.3 Omschakelen moet wél kunnen: eerst afzetten, dan aanzetten. Zo doet
  --      het scherm het ook (src/lib/clientObligations.ts).
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S40 Omschakeling', 12, 31, 'geen', true) returning id into v_bv;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_bv, v_ot_venb, true, current_date);

  update public.client_obligations set actief = false, geldig_tot = current_date
   where client_id = v_bv and obligation_type_id = v_ot_venb;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_bv, v_ot_rpb, true, current_date);
  raise notice 'PASS 40.3: van de VenB naar de RPB omschakelen lukt in één beweging';

  -- 40.4 Een stopgezette aangifte botst met niets meer.
  select count(*) into v_n from public.client_obligations co
   where co.client_id = v_bv and co.actief;
  if v_n <> 1 then
    raise exception 'FAIL 40.4: % lopende aangiftes na het omschakelen, verwacht 1', v_n;
  end if;
  raise notice 'PASS 40.4: na het omschakelen loopt er precies één aangifte';

  -- 40.5 Voorafbetalingen horen niet bij de rechtspersonenbelasting. Het
  --      kantoor: "als je RPB aanduidt is het beter om geen VA's aan te
  --      bieden." Beide richtingen, want welke van de twee je aanvinkt maakt
  --      voor de botsing niet uit.
  select id into v_ot_va from public.obligation_types where code = 'va_venb';
  v_geweigerd := false;
  begin
    insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
      values (v_vzw, v_ot_va, true, current_date);
  exception when check_violation then
    v_geweigerd := true;
  end;
  if not v_geweigerd then
    raise exception 'FAIL 40.5: een RPB-dossier kreeg voorafbetalingen';
  end if;

  v_geweigerd := false;
  begin
    insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
      values (v_bv, v_ot_va, true, current_date);
  exception when check_violation then
    v_geweigerd := true;
  end;
  if not v_geweigerd then
    raise exception 'FAIL 40.5: voorafbetalingen werden aanvaard naast de RPB';
  end if;
  raise notice 'PASS 40.5: voorafbetalingen gaan niet samen met de RPB, in beide richtingen';

  -- 40.6 Maar naast de vennootschapsbelasting horen ze er juist wél bij.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S40 Gewone vennootschap', 12, 31, 'geen', true) returning id into v_bv;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_bv, v_ot_venb, true, current_date), (v_bv, v_ot_va, true, current_date);
  raise notice 'PASS 40.6: naast de vennootschapsbelasting mogen de voorafbetalingen gewoon';
end $$;


-- ============================================================
-- Sectie 41 (0036): patrimoniumtaks en bijzondere btw-aangifte.
--
-- Twee verplichtingen die het kantoor als CONTROLE voert. De patrimoniumtaks
-- is pas verschuldigd boven 50.000 euro vermogen en die drempel toets je elk
-- jaar opnieuw; de bijzondere aangifte is alleen verschuldigd in een kwartaal
-- waarin er echt iets was. Beide staan er dus elk jaar of elk kwartaal, juist
-- om te kunnen nakijken.
--
-- Twee dingen die makkelijk stil fout gaan en daarom vastliggen:
--   * de patrimoniumtaks valt op 31 maart van HETZELFDE jaar als de periode.
--     De taks wordt geheven op het vermogen op 1 januari, dus de deadline ligt
--     binnen de periode -- anders dan bij elke andere jaarlijkse verplichting
--     in dit systeem.
--   * de bijzondere aangifte valt op de 25ste, niet op de 20ste. Dat is sinds
--     1 januari 2025 zo, samen met de gewone kwartaalaangifte.
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid;
  v_ot_pat uuid; v_ot_bijz uuid;
  v_klant uuid; v_periodiek uuid;
  v_n int; v_d date; v_geweigerd boolean := false;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's41@test.local', now());
  insert into public.firms (naam) values ('Sectie 41 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S41 Beheerder', 's41@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_uid::text, true);

  select id into v_ot_pat  from public.obligation_types where code = 'patrimoniumtaks';
  select id into v_ot_bijz from public.obligation_types where code = 'btw_bijzondere_aangifte';
  if v_ot_pat is null or v_ot_bijz is null then
    raise exception 'FAIL 41.0: de nieuwe verplichtingstypes staan niet in de catalogus';
  end if;

  insert into public.clients (firm_id, naam, rechtsvorm, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S41 Vereniging', 'VZW', 12, 31, 'vrijgesteld_kleine_onderneming', true)
    returning id into v_klant;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_klant, v_ot_pat, true, current_date), (v_klant, v_ot_bijz, true, current_date);

  perform public.generate_task_instances_intern(v_firm, 36, 0, null);

  -- 41.1 De patrimoniumtaks valt op 31 maart van hetzelfde jaar als de periode.
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_pat;
  if v_n = 0 then
    raise exception 'FAIL 41.1: de patrimoniumtaks leverde geen taken op';
  end if;
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_pat
     and due_date_wettelijk <> make_date(periode_label::int, 3, 31);
  if v_n <> 0 then
    raise exception 'FAIL 41.1: % taken staan niet op 31 maart van hun eigen jaar', v_n;
  end if;
  raise notice 'PASS 41.1: de patrimoniumtaks valt op 31 maart van hetzelfde jaar';

  -- 41.2 De bijzondere aangifte: de 25ste van de maand na het kwartaal.
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_bijz;
  if v_n = 0 then
    raise exception 'FAIL 41.2: de bijzondere btw-aangifte leverde geen taken op';
  end if;
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_bijz
     and due_date_wettelijk <> (date_trunc('month', periode_eind) + interval '1 month')::date + 24;
  if v_n <> 0 then
    raise exception 'FAIL 41.2: % taken staan niet op de 25ste na hun kwartaal', v_n;
  end if;
  select due_date_wettelijk into v_d from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_bijz order by due_date limit 1;
  if extract(day from v_d) <> 25 then
    raise exception 'FAIL 41.2: de eerste bijzondere aangifte valt op de %e, niet op de 25ste', extract(day from v_d);
  end if;
  raise notice 'PASS 41.2: de bijzondere aangifte valt op de 25ste na het kwartaal (%)', v_d;

  -- 41.3 Bij een periodieke aangever hoort ze niet: geweigerd bij het
  --      aanvinken, én de motor maakt er geen taken voor.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S41 Periodiek', 12, 31, 'periodieke_aangever', 'kwartaal', true)
    returning id into v_periodiek;
  begin
    insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
      values (v_periodiek, v_ot_bijz, true, current_date);
  exception when check_violation then
    v_geweigerd := true;
  end;
  if not v_geweigerd then
    raise exception 'FAIL 41.3: een periodieke aangever kreeg de bijzondere btw-aangifte';
  end if;
  raise notice 'PASS 41.3: de bijzondere aangifte wordt geweigerd bij een periodieke aangever';

  -- 41.4 Herhalen verandert niets.
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id in (v_ot_pat, v_ot_bijz);
  perform public.generate_task_instances_intern(v_firm, 36, 0, null);
  if (select count(*) from public.task_instances
       where client_id = v_klant and obligation_type_id in (v_ot_pat, v_ot_bijz)) <> v_n then
    raise exception 'FAIL 41.4: een tweede ronde maakte extra taken aan';
  end if;
  raise notice 'PASS 41.4: een tweede ronde levert geen dubbels op (% taken)', v_n;
end $$;


-- ============================================================
-- Sectie 42 (0037): een late algemene vergadering schuift de neerlegging niet.
--
-- De neerlegging hangt met voorloper_taak_id aan de AV en krijgt haar
-- definitieve datum zodra die AV afgevinkt wordt. Tot 0037 was dat altijd
-- "afgerond_op + 30 dagen", ook wanneer de vergadering maanden te laat
-- gehouden werd -- en dan schoof een deadline die al verstreken was gewoon
-- naar de toekomst. Het scherm zei dan dat je nog tijd had terwijl de
-- neerleggingskosten bij de NBB al opliepen.
--
-- De regel van het kantoor: de statuten blijven het ijkpunt. Te laat
-- vergaderd is een te laat dossier, geen uitgesteld dossier.
--
--   42.1  AV te laat  -> neerlegging blijft op geplande AV + 30 dagen
--   42.2  ... en staat daarmee zelf in het verleden: het dossier is dringend
--   42.3  AV op tijd  -> neerlegging op afronding + 30 dagen (ongewijzigd)
--   42.4  AV vroeger  -> neerlegging schuift mee naar vroeger (strenger mag)
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid;
  v_ot_av uuid; v_ot_nl uuid;
  v_klant uuid; v_co_av uuid;
  v_av_id uuid; v_nl_id uuid;
  v_gepland date; v_nl date; v_verwacht date;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's42@test.local', now());
  insert into public.firms (naam) values ('Sectie 42 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S42 Beheerder', 's42@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_uid::text, true);

  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';
  select id into v_ot_nl from public.obligation_types where code = 'neerlegging_jaarrekening';

  -- Een dossier met een statutaire AV: dat is het ijkpunt dat moet blijven.
  insert into public.clients (firm_id, naam, rechtsvorm, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S42 Laatkomer', 'BV', 12, 31, 'geen', true)
    returning id into v_klant;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters)
    values (v_klant, v_ot_av, true, current_date,
            jsonb_build_object('av_vorm', 'vaste_datum', 'av_maand', 5, 'av_dag', 15))
    returning id into v_co_av;

  perform public.generate_task_instances_intern(v_firm, 36, 0, null);

  -- De eerstvolgende AV-taak en haar neerlegging.
  select id, due_date_wettelijk into v_av_id, v_gepland
    from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_av
   order by due_date_wettelijk limit 1;
  if v_av_id is null then
    raise exception 'FAIL 42.0: er werd geen AV-taak aangemaakt';
  end if;

  select id into v_nl_id from public.task_instances
   where voorloper_taak_id = v_av_id and obligation_type_id = v_ot_nl;
  if v_nl_id is null then
    raise exception 'FAIL 42.0: er hangt geen neerlegging aan de AV-taak';
  end if;

  -- De geplande AV vier maanden in het verleden zetten. due_date_wettelijk is
  -- eigendom van de datumpijplijn; die sleutel is hoe de migraties zelf een
  -- ijkpunt verzetten (0033), en hier is dat precies wat we nabootsen: een
  -- dossier waarvan de statutaire vergaderdag al voorbij is.
  v_gepland := current_date - 120;
  perform set_config('taskflow.pipeline_task_id', v_av_id::text, true);
  update public.task_instances
     set due_date_wettelijk = v_gepland, due_date = public.next_business_day(v_gepland)
   where id = v_av_id;
  perform set_config('taskflow.pipeline_task_id', '', true);

  -- 42.1 De vergadering wordt pas vandaag afgevinkt, ver na die dag.
  update public.task_instances set status = 'wacht_op_goedkeuring' where id = v_av_id;
  update public.task_instances set status = 'ingediend_afgerond' where id = v_av_id;

  select due_date_wettelijk into v_nl from public.task_instances where id = v_nl_id;
  v_verwacht := v_gepland + 30;
  if v_nl <> v_verwacht then
    raise exception 'FAIL 42.1: de neerlegging staat op % in plaats van % (geplande AV % + 30)',
      v_nl, v_verwacht, v_gepland;
  end if;
  raise notice 'PASS 42.1: een late AV schuift de neerlegging niet vooruit (%)', v_nl;

  -- 42.2 En daarmee staat ze zelf in het verleden. Dat is de bedoeling: een
  -- te laat gehouden vergadering maakt het dossier dringend, geen uitgesteld
  -- dossier met een geruststellende datum.
  if v_nl >= current_date then
    raise exception 'FAIL 42.2: de neerlegging (%) ligt in de toekomst na een AV die % dagen te laat was',
      v_nl, current_date - v_gepland;
  end if;
  raise notice 'PASS 42.2: de neerlegging staat te laat en het dossier is dringend';
end $$;

do $$
declare
  v_uid uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid;
  v_ot_av uuid; v_ot_nl uuid;
  v_klant uuid;
  v_av_id uuid; v_nl_id uuid;
  v_gepland date; v_nl date; v_vandaag date := current_date;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's42b@test.local', now());
  insert into public.firms (naam) values ('Sectie 42b kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S42b Beheerder', 's42b@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_uid::text, true);

  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';
  select id into v_ot_nl from public.obligation_types where code = 'neerlegging_jaarrekening';

  insert into public.clients (firm_id, naam, rechtsvorm, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S42b Op tijd', 'BV', 12, 31, 'geen', true)
    returning id into v_klant;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_klant, v_ot_av, true, current_date);

  perform public.generate_task_instances_intern(v_firm, 36, 0, null);

  select id, due_date_wettelijk into v_av_id, v_gepland
    from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_av
     and due_date_wettelijk >= v_vandaag
   order by due_date_wettelijk limit 1;
  select id into v_nl_id from public.task_instances
   where voorloper_taak_id = v_av_id and obligation_type_id = v_ot_nl;

  -- 42.3 De vergadering wordt vandaag afgevinkt, ruim voor de geplande datum.
  -- Dan telt de wettelijke termijn van dertig dagen vanaf de goedkeuring: de
  -- neerlegging schuift mee naar vroeger. Strenger dan de planning mag.
  update public.task_instances set status = 'wacht_op_goedkeuring' where id = v_av_id;
  update public.task_instances set status = 'ingediend_afgerond' where id = v_av_id;

  select due_date_wettelijk into v_nl from public.task_instances where id = v_nl_id;
  if v_nl <> v_vandaag + 30 then
    raise exception 'FAIL 42.3: de neerlegging staat op % in plaats van % (vandaag + 30)',
      v_nl, v_vandaag + 30;
  end if;
  raise notice 'PASS 42.3: een AV die vroeger doorgaat brengt de neerlegging mee naar voren (%)', v_nl;

  -- 42.4 ... en dus zeker niet later dan de geplande datum + 30.
  if v_nl > v_gepland + 30 then
    raise exception 'FAIL 42.4: de neerlegging (%) ligt na de geplande AV + 30 dagen (%)',
      v_nl, v_gepland + 30;
  end if;
  raise notice 'PASS 42.4: de neerlegging ligt nooit na de geplande AV + 30 dagen';
end $$;


-- ============================================================
-- Sectie 43 (0038/0039): de teammuur.
--
-- RSM werkt in teams: Aalst, drie in Zaventem, Antwerpen, Gosselies. Een
-- dossier hoort bij één team en de rest van het kantoor hoort er niet in te
-- kunnen kijken. De afscherming loopt PER TEAM: dat ZAV1 en ZAV2 op hetzelfde
-- adres zitten geeft ze geen toegang tot elkaars dossiers.
--
-- Wat hier vastligt, en waarom elk stuk ervan:
--   43.1  je eigen team zie je
--   43.2  een ander team niet
--   43.3  ook niet binnen dezelfde vestiging (ZAV1 vs ZAV2)
--   43.4  een dossier zonder team blijft voor iedereen zichtbaar -- anders
--         verdwijnt bij het invoeren van teams honderd dossiers in stilte
--   43.5  een kantoorbeheerder ziet alles
--   43.6  meervoudig lidmaatschap werkt: in twee teams is twee teams zien
--   43.7  een toegewezen taak opent het dossier over de teamgrens heen
--   43.8  de taken zelf volgen dezelfde muur
--   43.9  een lidmaatschap over kantoorgrenzen wordt geweigerd
-- ============================================================
do $$
declare
  v_firm uuid; v_ander_firm uuid;
  v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_aal uuid;   v_aal_uid uuid := gen_random_uuid();
  v_zav1 uuid;  v_zav1_uid uuid := gen_random_uuid();
  v_beide uuid; v_beide_uid uuid := gen_random_uuid();
  v_ander_emp uuid;
  v_t_aal uuid; v_t_zav1 uuid; v_t_zav2 uuid; v_t_ant uuid;
  v_k_aal uuid; v_k_zav1 uuid; v_k_zav2 uuid; v_k_ant uuid; v_k_geen uuid;
  v_ot uuid; v_taak uuid;
  v_cnt int; v_ok boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_admin_uid, 's43-admin@test.local', now()),
    (v_aal_uid,   's43-aal@test.local',   now()),
    (v_zav1_uid,  's43-zav1@test.local',  now()),
    (v_beide_uid, 's43-beide@test.local', now());

  insert into public.firms (naam) values ('Sectie 43 kantoor') returning id into v_firm;
  insert into public.firms (naam) values ('Sectie 43 ander kantoor') returning id into v_ander_firm;

  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief) values
    (v_firm, v_admin_uid, 'S43 Beheerder', 's43-admin@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief) values
    (v_firm, v_aal_uid, 'S43 Aalst', 's43-aal@test.local', 'medewerker', false, true)
    returning id into v_aal;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief) values
    (v_firm, v_zav1_uid, 'S43 Zaventem 1', 's43-zav1@test.local', 'medewerker', false, true)
    returning id into v_zav1;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief) values
    (v_firm, v_beide_uid, 'S43 Vennoot', 's43-beide@test.local', 'medewerker', false, true)
    returning id into v_beide;
  insert into public.employees (firm_id, naam, email, rol, mag_goedkeuren, actief) values
    (v_ander_firm, 'S43 Buitenstaander', 's43-buiten@test.local', 'medewerker', false, true)
    returning id into v_ander_emp;

  -- 0038 zaait de zes teams per kantoor; deze kantoren zijn na die migratie
  -- aangemaakt, dus hier zelf.
  insert into public.teams (firm_id, code, naam, vestiging) values
    (v_firm, 'AAL',  'Aalst',      'Aalst')     returning id into v_t_aal;
  insert into public.teams (firm_id, code, naam, vestiging) values
    (v_firm, 'ZAV1', 'Zaventem 1', 'Zaventem')  returning id into v_t_zav1;
  insert into public.teams (firm_id, code, naam, vestiging) values
    (v_firm, 'ZAV2', 'Zaventem 2', 'Zaventem')  returning id into v_t_zav2;
  insert into public.teams (firm_id, code, naam, vestiging) values
    (v_firm, 'ANT',  'Antwerpen',  'Antwerpen') returning id into v_t_ant;

  insert into public.employee_teams (employee_id, team_id) values
    (v_aal, v_t_aal), (v_zav1, v_t_zav1), (v_beide, v_t_aal), (v_beide, v_t_ant);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id) values
    (v_firm, 'S43 Klant Aalst', 12, 31, 'geen', true, v_t_aal)  returning id into v_k_aal;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id) values
    (v_firm, 'S43 Klant Zaventem 1', 12, 31, 'geen', true, v_t_zav1) returning id into v_k_zav1;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id) values
    (v_firm, 'S43 Klant Zaventem 2', 12, 31, 'geen', true, v_t_zav2) returning id into v_k_zav2;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id) values
    (v_firm, 'S43 Klant Antwerpen', 12, 31, 'geen', true, v_t_ant)  returning id into v_k_ant;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief) values
    (v_firm, 'S43 Klant zonder team', 12, 31, 'geen', true)      returning id into v_k_geen;

  -- ---------- als medewerker van Aalst ----------
  perform set_config('taskflow.test_uid', v_aal_uid::text, true);
  set local role authenticated;

  select count(*) into v_cnt from public.clients where id = v_k_aal;
  if v_cnt <> 1 then raise exception 'FAIL 43.1: het eigen teamdossier is onzichtbaar'; end if;
  raise notice 'PASS 43.1: je ziet de dossiers van je eigen team';

  select count(*) into v_cnt from public.clients where id = v_k_ant;
  if v_cnt <> 0 then raise exception 'FAIL 43.2: Aalst ziet een dossier van Antwerpen'; end if;
  raise notice 'PASS 43.2: een dossier van een ander team blijft onzichtbaar';

  select count(*) into v_cnt from public.clients where id = v_k_geen;
  if v_cnt <> 1 then
    raise exception 'FAIL 43.4: een dossier zonder team is onzichtbaar geworden';
  end if;
  raise notice 'PASS 43.4: een dossier zonder team blijft voor iedereen zichtbaar';

  -- ---------- als medewerker van Zaventem 1 ----------
  set local role postgres;
  perform set_config('taskflow.test_uid', v_zav1_uid::text, true);
  set local role authenticated;

  select count(*) into v_cnt from public.clients where id = v_k_zav1;
  if v_cnt <> 1 then raise exception 'FAIL 43.3: ZAV1 ziet zijn eigen dossier niet'; end if;
  select count(*) into v_cnt from public.clients where id = v_k_zav2;
  if v_cnt <> 0 then
    raise exception 'FAIL 43.3: ZAV1 ziet een dossier van ZAV2 -- de vestiging mag niet groeperen';
  end if;
  raise notice 'PASS 43.3: binnen dezelfde vestiging staan de teams apart (ZAV1 ziet ZAV2 niet)';

  -- ---------- als kantoorbeheerder ----------
  set local role postgres;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;

  select count(*) into v_cnt from public.clients
   where id in (v_k_aal, v_k_zav1, v_k_zav2, v_k_ant, v_k_geen);
  if v_cnt <> 5 then
    raise exception 'FAIL 43.5: een kantoorbeheerder ziet maar % van de 5 dossiers', v_cnt;
  end if;
  raise notice 'PASS 43.5: een kantoorbeheerder ziet alle dossiers';

  -- ---------- als vennoot in twee teams ----------
  set local role postgres;
  perform set_config('taskflow.test_uid', v_beide_uid::text, true);
  set local role authenticated;

  select count(*) into v_cnt from public.clients where id in (v_k_aal, v_k_ant);
  if v_cnt <> 2 then
    raise exception 'FAIL 43.6: meervoudig lidmaatschap levert maar % dossiers op', v_cnt;
  end if;
  select count(*) into v_cnt from public.clients where id = v_k_zav1;
  if v_cnt <> 0 then
    raise exception 'FAIL 43.6: lid van AAL en ANT zien betekent niet ZAV1 zien';
  end if;
  raise notice 'PASS 43.6: wie in twee teams zit, ziet precies die twee';

  -- ---------- een toegewezen taak opent het dossier ----------
  set local role postgres;
  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_k_ant, v_ot, '2026', current_date, current_date, 'open', v_aal,
    'automatisch_gegenereerd', true
  ) returning id into v_taak;
  perform set_config('taskflow.generating', 'off', true);

  perform set_config('taskflow.test_uid', v_aal_uid::text, true);
  set local role authenticated;

  select count(*) into v_cnt from public.clients where id = v_k_ant;
  if v_cnt <> 1 then
    raise exception 'FAIL 43.7: een toegewezen taak opent het dossier niet over de teamgrens';
  end if;
  raise notice 'PASS 43.7: wie een taak toegewezen kreeg, ziet dat dossier ook buiten zijn team';

  -- ---------- de taken volgen dezelfde muur ----------
  set local role postgres;
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_k_zav2, v_ot, '2026', current_date, current_date, 'open', v_zav1,
    'automatisch_gegenereerd', true
  );
  perform set_config('taskflow.generating', 'off', true);

  perform set_config('taskflow.test_uid', v_aal_uid::text, true);
  set local role authenticated;

  select count(*) into v_cnt from public.task_instances where client_id = v_k_zav2;
  if v_cnt <> 0 then
    raise exception 'FAIL 43.8: Aalst ziet % taak/taken van een Zaventem-dossier', v_cnt;
  end if;
  raise notice 'PASS 43.8: de taken van een ander team zijn onzichtbaar';

  -- ---------- lidmaatschap over kantoorgrenzen ----------
  set local role postgres;
  v_ok := false;
  begin
    insert into public.employee_teams (employee_id, team_id) values (v_ander_emp, v_t_aal);
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 43.9: een medewerker van een ander kantoor kon lid worden van dit team';
  end if;
  raise notice 'PASS 43.9: een lidmaatschap over kantoorgrenzen wordt geweigerd';

  set local role postgres;
end $$;

-- ============================================================
-- Sectie 44 (0040): de teambak -- een taak zonder naam.
--
-- "De teams zijn verantwoordelijk voor de taken, niet per se één persoon."
-- Twee dingen die daarvoor moesten wijken:
--   * de terugval op "de oudste actieve kantoorbeheerder", die werk op iemands
--     naam zette dat hij nooit gekregen had;
--   * het stil overslaan van een dossier zonder verantwoordelijke, waardoor een
--     klant met verplichtingen eruitzag als een klant zonder.
--
--   44.1  de motor genereert wél, en zonder naam
--   44.2  het werk komt niet op de kantoorbeheerder terecht
--   44.3  een taak teruggeven aan het team mag, en staat herkenbaar in het log
--   44.4  staat er wél een naam, dan geldt de kantoorgrens onverkort
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_firm uuid; v_ander_firm uuid; v_admin uuid; v_vreemde uuid;
  v_klant uuid; v_ot uuid; v_taak uuid;
  v_n int; v_naam uuid; v_notitie text; v_ok boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's44@test.local', now());
  insert into public.firms (naam) values ('Sectie 44 kantoor') returning id into v_firm;
  insert into public.firms (naam) values ('Sectie 44 ander kantoor') returning id into v_ander_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S44 Beheerder', 's44@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_ander_firm, 'S44 Vreemde', 's44-vreemd@test.local', 'medewerker', false, true)
    returning id into v_vreemde;
  perform set_config('taskflow.test_uid', v_uid::text, true);

  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';

  -- Een dossier zonder standaard verantwoordelijke: precies het geval dat
  -- vroeger overgeslagen werd of op de kantoorbeheerder belandde.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S44 Klant zonder verantwoordelijke', 12, 31, 'geen', true)
    returning id into v_klant;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_klant, v_ot, true, current_date);

  perform public.generate_task_instances_intern(v_firm, 36, 0, null);

  select count(*) into v_n from public.task_instances where client_id = v_klant;
  if v_n = 0 then
    raise exception 'FAIL 44.1: het dossier werd overgeslagen omdat er geen verantwoordelijke was';
  end if;
  raise notice 'PASS 44.1: de motor genereert ook zonder verantwoordelijke (% taken)', v_n;

  select count(*) into v_n from public.task_instances
   where client_id = v_klant and toegewezen_medewerker_id is null;
  if v_n = 0 then
    raise exception 'FAIL 44.2: de taken kregen tóch een naam -- de terugval leeft nog';
  end if;
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and toegewezen_medewerker_id = v_admin;
  if v_n <> 0 then
    raise exception 'FAIL 44.2: % taak/taken belandden op de kantoorbeheerder', v_n;
  end if;
  raise notice 'PASS 44.2: de taken liggen in de teambak, niet op de kantoorbeheerder';

  -- 44.3 Een taak oppakken en weer teruggeven.
  select id into v_taak from public.task_instances where client_id = v_klant limit 1;
  update public.task_instances set toegewezen_medewerker_id = v_admin where id = v_taak;
  update public.task_instances set toegewezen_medewerker_id = null where id = v_taak;

  select toegewezen_medewerker_id into v_naam from public.task_instances where id = v_taak;
  if v_naam is not null then
    raise exception 'FAIL 44.3: de taak kon niet teruggelegd worden in de teambak';
  end if;

  -- Niet "de laatste logregel": now() staat vast binnen een transactie, dus
  -- opnemen en terugleggen dragen hier dezelfde created_at. Het gaat erom DAT
  -- allebei de gebeurtenissen herkenbaar in het log staan.
  select count(*) into v_n from public.task_status_log
   where task_instance_id = v_taak and event_type = 'toewijzing_gewijzigd'
     and notitie like 'Teruggelegd in de bak van het team%';
  if v_n <> 1 then
    raise exception 'FAIL 44.3: het terugleggen staat niet herkenbaar in het log (% regels)', v_n;
  end if;
  select count(*) into v_n from public.task_status_log
   where task_instance_id = v_taak and event_type = 'toewijzing_gewijzigd'
     and notitie like 'Opgenomen uit de bak van het team%';
  if v_n <> 1 then
    raise exception 'FAIL 44.3: het oppakken staat niet herkenbaar in het log (% regels)', v_n;
  end if;
  raise notice 'PASS 44.3: opnemen en terugleggen staan allebei herkenbaar in het log';

  -- 44.4 Met een naam erop blijft de kantoorgrens gelden.
  v_ok := false;
  begin
    update public.task_instances set toegewezen_medewerker_id = v_vreemde where id = v_taak;
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 44.4: een medewerker van een ander kantoor kon de taak krijgen';
  end if;
  raise notice 'PASS 44.4: met een naam erop geldt de kantoorgrens onverkort';
end $$;


-- ============================================================
-- Sectie 45 (0041): de aangifte personenbelasting.
--
-- Sinds de hervorming van 2023 bestaat het aparte uitstel voor mandatarissen
-- niet meer. De termijn hangt af van de aangifte zelf: complex (winsten of
-- baten, bedrijfsleidersbezoldiging, buitenlands beroepsinkomen) tegen 16
-- oktober, eenvoudig tegen 15 juli. Bij een boekhoudkantoor is vrijwel elk
-- dossier complex, dus dat is de standaard.
--
--   45.1  standaard = complex = 16 oktober van het jaar NA het inkomstenjaar
--   45.2  "eenvoudig" levert 15 juli op
--   45.3  de periode is het kalenderjaar, niet een boekjaar
--   45.4  de wettelijke kalender overschrijft, en enkel voor de juiste vorm
--   45.5  PB gaat niet samen met VenB, in beide richtingen
--   45.6  PB gaat niet samen met de RPB
-- ============================================================
do $$
declare
  v_uid uuid := gen_random_uuid();
  v_firm uuid; v_admin uuid;
  v_ot_pb uuid; v_ot_venb uuid; v_ot_rpb uuid;
  v_zaak uuid; v_privaat uuid; v_botser uuid;
  v_d date; v_ps date; v_pe date; v_n int; v_ok boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_uid, 's45@test.local', now());
  insert into public.firms (naam) values ('Sectie 45 kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_uid, 'S45 Beheerder', 's45@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_uid::text, true);

  select id into v_ot_pb   from public.obligation_types where code = 'aangifte_pb';
  select id into v_ot_venb from public.obligation_types where code = 'aangifte_venb_pb';
  select id into v_ot_rpb  from public.obligation_types where code = 'aangifte_rpb';
  if v_ot_pb is null then
    raise exception 'FAIL 45.0: de aangifte personenbelasting staat niet in de catalogus';
  end if;

  -- Een eenmanszaak: natuurlijke persoon MET btw. Dat de klantsoort bestaat en
  -- naast een btw-regime kan staan, is precies het punt.
  insert into public.clients (firm_id, naam, klantsoort, rechtsvorm, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S45 Eenmanszaak', 'natuurlijk_persoon', 'Eenmanszaak', 12, 31, 'periodieke_aangever', 'kwartaal', true)
    returning id into v_zaak;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_zaak, v_ot_pb, true, current_date);

  perform public.generate_task_instances_intern(v_firm, 36, 0, null);

  -- 45.1 Standaard is complex: 16 oktober van het jaar na het inkomstenjaar.
  select due_date_wettelijk, periode_start, periode_eind into v_d, v_ps, v_pe
  from public.task_instances ti
  where ti.client_id = v_zaak and ti.obligation_type_id = v_ot_pb
  order by ti.due_date_wettelijk limit 1;

  if v_d is null then
    raise exception 'FAIL 45.1: de aangifte personenbelasting leverde geen taken op';
  end if;
  if extract(month from v_d) <> 10 or extract(day from v_d) <> 16 then
    raise exception 'FAIL 45.1: de complexe aangifte valt op % in plaats van 16 oktober', v_d;
  end if;
  if extract(year from v_d) <> extract(year from v_pe) + 1 then
    raise exception 'FAIL 45.1: de deadline (%) hoort in het jaar NA het inkomstenjaar (%)', v_d, v_pe;
  end if;
  raise notice 'PASS 45.1: de complexe aangifte valt op 16 oktober na het inkomstenjaar (%)', v_d;

  -- 45.3 De periode is het kalenderjaar. De personenbelasting kent geen
  -- boekjaar, ook niet wanneer het dossier er toevallig een heeft staan.
  if extract(month from v_ps) <> 1 or extract(day from v_ps) <> 1
     or extract(month from v_pe) <> 12 or extract(day from v_pe) <> 31 then
    raise exception 'FAIL 45.3: de periode loopt van % tot % in plaats van een kalenderjaar', v_ps, v_pe;
  end if;
  raise notice 'PASS 45.3: de periode is het kalenderjaar (% tot %)', v_ps, v_pe;

  -- 45.2 Een eenvoudige aangifte: 15 juli.
  insert into public.clients (firm_id, naam, klantsoort, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S45 Particulier', 'natuurlijk_persoon', 12, 31, 'geen', true)
    returning id into v_privaat;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters)
    values (v_privaat, v_ot_pb, true, current_date, jsonb_build_object('aangifte_vorm', 'eenvoudig'));

  perform public.generate_task_instances_intern(v_firm, 36, 0, null);

  select due_date_wettelijk into v_d from public.task_instances
   where client_id = v_privaat and obligation_type_id = v_ot_pb
   order by due_date_wettelijk limit 1;
  if extract(month from v_d) <> 7 or extract(day from v_d) <> 15 then
    raise exception 'FAIL 45.2: de eenvoudige aangifte valt op % in plaats van 15 juli', v_d;
  end if;
  raise notice 'PASS 45.2: de eenvoudige aangifte valt op 15 juli (%)', v_d;

  -- 45.4 De wettelijke kalender overschrijft, en enkel voor de vorm waarvoor
  -- ze ingevuld is: een campagnedatum voor de eenvoudige aangifte mag de
  -- complexe niet verzetten.
  insert into public.legal_calendar (obligation_type_id, jaar, scope, deadline_datum, is_override, aangemaakt_door, gewijzigd_door)
  values (v_ot_pb, extract(year from v_pe)::int, 'vorm_complex', make_date(extract(year from v_pe)::int + 1, 11, 4), true, v_admin, v_admin);

  -- recalc_due_dates_on_legal_calendar_override() verzet de lopende taken al
  -- bij het invoeren; de generator neemt de datum daarna sowieso over.
  select due_date_wettelijk into v_d from public.task_instances
   where client_id = v_zaak and obligation_type_id = v_ot_pb and periode_eind = v_pe;
  if v_d <> make_date(extract(year from v_pe)::int + 1, 11, 4) then
    raise exception 'FAIL 45.4: de campagnedatum uit de wettelijke kalender werd niet gevolgd (% i.p.v. %)',
      v_d, make_date(extract(year from v_pe)::int + 1, 11, 4);
  end if;
  raise notice 'PASS 45.4: een campagnedatum uit de wettelijke kalender wint (%)', v_d;

  -- En ze geldt enkel voor de vorm waarvoor ze ingevuld is: de eenvoudige
  -- aangifte van de particulier mag er niet door verschuiven.
  select due_date_wettelijk into v_d from public.task_instances
   where client_id = v_privaat and obligation_type_id = v_ot_pb and periode_eind = v_pe;
  if extract(month from v_d) <> 7 or extract(day from v_d) <> 15 then
    raise exception 'FAIL 45.4: een campagnedatum voor de complexe aangifte verzette ook de eenvoudige (%)', v_d;
  end if;
  raise notice 'PASS 45.4b: de campagnedatum raakt enkel de vorm waarvoor ze geldt';

  -- 45.5/45.6 Wat niet samen kan.
  insert into public.clients (firm_id, naam, klantsoort, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S45 Botser', 'rechtspersoon', 12, 31, 'geen', true)
    returning id into v_botser;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_botser, v_ot_venb, true, current_date);

  v_ok := false;
  begin
    insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
      values (v_botser, v_ot_pb, true, current_date);
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 45.5: een dossier kreeg de personenbelasting naast de vennootschapsbelasting';
  end if;
  raise notice 'PASS 45.5: PB gaat niet samen met de VenB';

  -- En de andere richting: eerst PB, dan VenB.
  update public.client_obligations set actief = false
   where client_id = v_botser and obligation_type_id = v_ot_venb;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_botser, v_ot_pb, true, current_date);

  v_ok := false;
  begin
    insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
      values (v_botser, v_ot_rpb, true, current_date);
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'FAIL 45.6: een dossier kreeg de RPB naast de personenbelasting';
  end if;
  raise notice 'PASS 45.6: PB gaat niet samen met de RPB, ook in deze richting';
end $$;

-- ============================================================
-- Sectie 46 (0042): het goedkeuringsrecht volgt de graad.
--
-- Zes niveaus, en vanaf manager mag je aangiftes goedkeuren. Vroeger stond dat
-- als een los vinkje naast de rol: het kon op een junior staan zonder dat iets
-- protesteerde, en ontbreken bij een manager zonder dat iemand het zag.
--
--   46.1  een junior mag niet goedkeuren, ook niet als je het vinkje zet
--   46.2  een manager mag het, zonder dat je iets aanvinkt
--   46.3  bevorderd worden geeft het recht mee
--   46.4  zonder niveau blijft het handmatige vinkje staan
--   46.5  de rol staat er los van: kantoorbeheerder is geen graad
-- ============================================================
do $$
declare
  v_firm uuid;
  v_junior uuid; v_manager uuid; v_oud uuid; v_beheerder uuid;
  v_mag boolean;
begin
  insert into public.firms (naam) values ('Sectie 46 kantoor') returning id into v_firm;

  -- 46.1 Het vinkje meteen mee proberen zetten bij een junior.
  insert into public.employees (firm_id, naam, email, rol, niveau, mag_goedkeuren, actief)
    values (v_firm, 'S46 Junior', 's46-junior@test.local', 'medewerker', 'junior', true, true)
    returning id into v_junior;
  select mag_goedkeuren into v_mag from public.employees where id = v_junior;
  if v_mag then
    raise exception 'FAIL 46.1: een junior kreeg goedkeuringsrecht omdat het vinkje aanstond';
  end if;
  raise notice 'PASS 46.1: bij een junior springt het vinkje terug, ook als je het zet';

  -- 46.2 En bij een manager komt het er vanzelf bij.
  insert into public.employees (firm_id, naam, email, rol, niveau, mag_goedkeuren, actief)
    values (v_firm, 'S46 Manager', 's46-manager@test.local', 'medewerker', 'manager', false, true)
    returning id into v_manager;
  select mag_goedkeuren into v_mag from public.employees where id = v_manager;
  if not v_mag then
    raise exception 'FAIL 46.2: een manager mag niet goedkeuren';
  end if;
  raise notice 'PASS 46.2: een manager mag goedkeuren zonder dat je iets aanvinkt';

  -- 46.3 Bevorderd worden.
  update public.employees set niveau = 'director' where id = v_junior;
  select mag_goedkeuren into v_mag from public.employees where id = v_junior;
  if not v_mag then
    raise exception 'FAIL 46.3: bevorderd tot director en nog altijd geen goedkeuringsrecht';
  end if;
  raise notice 'PASS 46.3: bevorderen geeft het goedkeuringsrecht mee';

  -- 46.4 Zonder niveau verandert er niets aan wat er met de hand stond. Anders
  -- zou deze migratie bestaande medewerkers stil hun recht afnemen.
  insert into public.employees (firm_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, 'S46 Zonder graad', 's46-zonder@test.local', 'medewerker', true, true)
    returning id into v_oud;
  select mag_goedkeuren into v_mag from public.employees where id = v_oud;
  if not v_mag then
    raise exception 'FAIL 46.4: zonder niveau werd het handmatige vinkje toch gewist';
  end if;
  raise notice 'PASS 46.4: zonder niveau blijft het handmatige vinkje staan';

  -- 46.5 De rol is een andere as: beheer in de app, geen beroepsgraad.
  insert into public.employees (firm_id, naam, email, rol, niveau, mag_goedkeuren, actief)
    values (v_firm, 'S46 Beheerder', 's46-beheer@test.local', 'kantoorbeheerder', 'supervisor', true, true)
    returning id into v_beheerder;
  select mag_goedkeuren into v_mag from public.employees where id = v_beheerder;
  if v_mag then
    raise exception 'FAIL 46.5: kantoorbeheerder gaf goedkeuringsrecht aan een supervisor';
  end if;
  raise notice 'PASS 46.5: kantoorbeheerder zijn is geen graad en geeft geen goedkeuringsrecht';
end $$;


-- ============================================================
-- Sectie 47 (0043): het weekoverzicht.
--
-- De inhoud van de maandagmail. Wat hier fout gaat, gaat per e-mail de deur
-- uit en is niet meer terug te halen -- vandaar dat de muur van 0039 hier even
-- hard moet staan als op het scherm.
--
--   47.1  wat te laat is en op jouw naam staat, staat in het blok "te laat"
--   47.2  wat deze week vervalt, staat apart
--   47.3  werk zonder naam uit JOUW team staat in de teambak
--   47.4  ... en dat van een ander team niet
--   47.5  een dossier van een ander team komt nergens in het overzicht
--   47.6  wie niet mag goedkeuren, krijgt geen goedkeuringsblok
--   47.7  wie niets te melden heeft, staat niet bij de ontvangers
--   47.8  de lijsten worden afgekapt, met het volledige aantal ernaast
-- ============================================================
do $$
declare
  v_firm uuid;
  v_ik uuid;     v_ik_uid uuid := gen_random_uuid();
  v_baas uuid;   v_baas_uid uuid := gen_random_uuid();
  v_ander uuid;
  v_t_mijn uuid; v_t_ander uuid;
  v_k_mijn uuid; v_k_ander uuid;
  v_ot uuid;
  v_o jsonb; v_baas_o jsonb; v_n int; v_i int;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_ik_uid, 's47-ik@test.local', now()), (v_baas_uid, 's47-baas@test.local', now());
  insert into public.firms (naam) values ('Sectie 47 kantoor') returning id into v_firm;

  insert into public.employees (firm_id, auth_user_id, naam, email, rol, niveau, actief)
    values (v_firm, v_ik_uid, 'S47 Ik', 's47-ik@test.local', 'medewerker', 'senior', true)
    returning id into v_ik;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, niveau, actief)
    values (v_firm, v_baas_uid, 'S47 Manager', 's47-baas@test.local', 'medewerker', 'manager', true)
    returning id into v_baas;
  insert into public.employees (firm_id, naam, email, rol, niveau, actief)
    values (v_firm, 'S47 Ander team', 's47-ander@test.local', 'medewerker', 'senior', true)
    returning id into v_ander;

  insert into public.teams (firm_id, code, naam, vestiging) values (v_firm, 'MIJN', 'Mijn team', 'Aalst')
    returning id into v_t_mijn;
  insert into public.teams (firm_id, code, naam, vestiging) values (v_firm, 'AND', 'Ander team', 'Antwerpen')
    returning id into v_t_ander;
  insert into public.employee_teams (employee_id, team_id) values
    (v_ik, v_t_mijn), (v_baas, v_t_mijn), (v_ander, v_t_ander);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id)
    values (v_firm, 'S47 Mijn klant', 12, 31, 'geen', true, v_t_mijn) returning id into v_k_mijn;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id)
    values (v_firm, 'S47 Andermans klant', 12, 31, 'geen', true, v_t_ander) returning id into v_k_ander;

  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';
  perform set_config('taskflow.generating', 'on', true);

  -- Op mijn naam: één te laat, één deze week, één ver weg.
  insert into public.task_instances (client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk, status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
  values
    (v_k_mijn, v_ot, 'TE-LAAT', current_date - 10, current_date - 10, 'open', v_ik, 'automatisch_gegenereerd', true),
    (v_k_mijn, v_ot, 'DEZE-WEEK', current_date + 3, current_date + 3, 'open', v_ik, 'automatisch_gegenereerd', true),
    (v_k_mijn, v_ot, 'LATER', current_date + 90, current_date + 90, 'open', v_ik, 'automatisch_gegenereerd', true);

  -- Zonder naam: één in mijn team, één in het andere, en één in mijn team dat
  -- nog ver weg ligt. Die laatste bewaakt de horizon van de bak: zonder die
  -- rij zou het weglaten van de datumgrens niets breken en zou de test groen
  -- blijven om de verkeerde reden.
  insert into public.task_instances (client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk, status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
  values
    (v_k_mijn, v_ot, 'BAK-MIJN', current_date + 5, current_date + 5, 'open', null, 'automatisch_gegenereerd', true),
    (v_k_mijn, v_ot, 'BAK-VERWEG', current_date + 90, current_date + 90, 'open', null, 'automatisch_gegenereerd', true),
    (v_k_ander, v_ot, 'BAK-ANDER', current_date + 5, current_date + 5, 'open', null, 'automatisch_gegenereerd', true);

  -- Iets dat op goedkeuring wacht, bij een collega van mijn team. En hetzelfde
  -- bij een dossier van het ANDERE team: dat is wat de muur moet tegenhouden.
  -- Zonder die tweede rij zou het weghalen van mag_klant_zien() niets breken.
  insert into public.task_instances (client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk, status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
  -- En één van een collega op MIJN dossier: die zou in mijn goedkeuringsblok
  -- belanden als de rechtencontrole zou wegvallen. Zonder deze rij blijft die
  -- test groen om de verkeerde reden.
  values
    (v_k_mijn, v_ot, 'GOEDKEURING', current_date + 4, current_date + 4, 'open', v_ik, 'automatisch_gegenereerd', true),
    (v_k_mijn, v_ot, 'GOEDKEURING-COLLEGA', current_date + 4, current_date + 4, 'open', v_baas, 'automatisch_gegenereerd', true),
    (v_k_ander, v_ot, 'GOEDKEURING-ANDER', current_date + 4, current_date + 4, 'open', v_ander, 'automatisch_gegenereerd', true);
  perform set_config('taskflow.generating', 'off', true);

  -- Ze moeten de echte weg lopen naar "wacht op goedkeuring": migratie 0013
  -- weigert motoroutput in een verzonnen status, dus een rechtstreekse insert
  -- met die status wordt stil als 'open' bewaard. Dat is precies waarom deze
  -- fixture eerst groen bleef terwijl ze niets bewees.
  perform set_config('taskflow.test_uid', v_ik_uid::text, true);
  update public.task_instances set status = 'wacht_op_goedkeuring'
   where periode_label in ('GOEDKEURING', 'GOEDKEURING-COLLEGA', 'GOEDKEURING-ANDER')
     and client_id in (v_k_mijn, v_k_ander);

  if (select count(*) from public.task_instances ti
      where ti.periode_label like 'GOEDKEURING%' and ti.status = 'wacht_op_goedkeuring'
        and ti.client_id in (v_k_mijn, v_k_ander)) <> 3 then
    raise exception 'FAIL 47.0: de fixture kreeg de goedkeuringsstatus niet gezet';
  end if;

  v_o := public.weekoverzicht_voor(v_ik);

  -- 47.1
  if (v_o #>> '{blokken,te_laat,totaal}')::int <> 1
     or (v_o #>> '{blokken,te_laat,taken,0,periode}') <> 'TE-LAAT' then
    raise exception 'FAIL 47.1: het blok "te laat" klopt niet (%)', v_o #> '{blokken,te_laat}';
  end if;
  raise notice 'PASS 47.1: wat te laat is en op jouw naam staat, staat vooraan';

  -- 47.2 Twee taken van mij vervallen deze week: de gewone, en die welke op
  -- goedkeuring wacht. Die laatste blijft mijn werk zolang ze niet goedgekeurd
  -- is, dus ze hoort hier thuis -- ze staat straks óók in het goedkeuringsblok
  -- van de manager, en dat is niet dubbel maar twee verschillende vragen.
  -- De taak van over drie maanden hoort er niet bij.
  if (v_o #>> '{blokken,deze_week,totaal}')::int <> 2
     or v_o #>> '{blokken,deze_week}' not like '%DEZE-WEEK%'
     or v_o #>> '{blokken,deze_week}' not like '%GOEDKEURING%'
     or v_o #>> '{blokken,deze_week}' like '%LATER%' then
    raise exception 'FAIL 47.2: het blok "deze week" klopt niet (%)', v_o #> '{blokken,deze_week}';
  end if;
  raise notice 'PASS 47.2: deze week staat apart, en wat later komt blijft eruit';

  -- 47.3/47.4 Alleen BAK-MIJN: niet dat van het andere team, en niet dat van
  -- over drie maanden.
  if (v_o #>> '{blokken,teambak,totaal}')::int <> 1
     or (v_o #>> '{blokken,teambak,taken,0,periode}') <> 'BAK-MIJN' then
    raise exception 'FAIL 47.3: de teambak klopt niet (%)', v_o #> '{blokken,teambak}';
  end if;
  raise notice 'PASS 47.3/47.4: enkel het werk zonder naam uit je eigen team, en enkel wat eraan komt';

  -- 47.5 Niets van het andere team, in geen enkel blok.
  if v_o::text like '%Andermans klant%' then
    raise exception 'FAIL 47.5: een dossier van een ander team staat in het weekoverzicht';
  end if;
  raise notice 'PASS 47.5: de muur van 0039 geldt ook per e-mail';

  -- 47.6 Ik ben senior en mag niet goedkeuren.
  if v_o #> '{blokken,wacht_op_jou}' is not null then
    raise exception 'FAIL 47.6: een senior kreeg een goedkeuringsblok';
  end if;
  -- De manager wel -- maar alleen voor het dossier van zijn eigen team. Het
  -- dossier van het andere team wacht óók op goedkeuring en mag er niet in.
  v_baas_o := public.weekoverzicht_voor(v_baas);

  if (v_baas_o #>> '{blokken,wacht_op_jou,totaal}')::int <> 1
     or (v_baas_o #>> '{blokken,wacht_op_jou,taken,0,periode}') <> 'GOEDKEURING' then
    raise exception 'FAIL 47.6: het goedkeuringsblok van de manager klopt niet (%)',
      v_baas_o #> '{blokken,wacht_op_jou}';
  end if;
  if v_baas_o::text like '%Andermans klant%' then
    raise exception 'FAIL 47.6: de manager ziet een dossier van een ander team in zijn goedkeuringsblok';
  end if;
  raise notice 'PASS 47.6: het goedkeuringsblok verschijnt enkel bij wie mag goedkeuren, en enkel voor zijn eigen dossiers';

  -- 47.7 Wie in geen enkel blok voorkomt, krijgt geen mail.
  select count(*) into v_n from public.weekoverzicht_ontvangers()
   where employee_id = v_ander;
  if v_n <> 0 then
    raise exception 'FAIL 47.7: iemand zonder werk staat toch bij de ontvangers';
  end if;
  select count(*) into v_n from public.weekoverzicht_ontvangers() where employee_id = v_ik;
  if v_n <> 1 then
    raise exception 'FAIL 47.7: wie wél werk heeft, staat niet bij de ontvangers';
  end if;
  raise notice 'PASS 47.7: alleen wie iets te melden heeft, krijgt een mail';

  -- 47.8 Afkappen, met het volledige aantal ernaast. Een mail die zwijgt over
  -- wat ze weglaat, is erger dan geen mail.
  perform set_config('taskflow.generating', 'on', true);
  for v_i in 1..20 loop
    insert into public.task_instances (client_id, obligation_type_id, periode_label, due_date, due_date_wettelijk, status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_k_mijn, v_ot, 'BULK-' || v_i, current_date - 20 - v_i, current_date - 20 - v_i, 'open', v_ik, 'automatisch_gegenereerd', true);
  end loop;
  perform set_config('taskflow.generating', 'off', true);

  v_o := public.weekoverzicht_voor(v_ik, current_date, 5);
  if (v_o #>> '{blokken,te_laat,totaal}')::int <> 21 then
    raise exception 'FAIL 47.8: het totaal klopt niet (% i.p.v. 21)', v_o #>> '{blokken,te_laat,totaal}';
  end if;
  if jsonb_array_length(v_o #> '{blokken,te_laat,taken}') <> 5 then
    raise exception 'FAIL 47.8: er staan % regels in plaats van de vijf gevraagde',
      jsonb_array_length(v_o #> '{blokken,te_laat,taken}');
  end if;
  raise notice 'PASS 47.8: de lijst wordt afgekapt op 5, met het volledige aantal (21) ernaast';
end $$;


-- ============================================================
-- Sectie 48 (0044): een teamwissel laat een spoor na.
--
-- Achtergrond: bij de review van de teammuur bleek dat een gewone medewerker
-- van een dossier dat hij ziet het team kan wegnemen -- waarna het hele
-- kantoor het ziet. De databank had die afweging al gemaakt voor
-- `vertrouwelijk` (kantoorbeheerder + audit); `team_id` doet sinds 0039
-- hetzelfde werk en was door beide zeven gevallen.
--
-- Deze sectie legt het spoor vast, niet het slot: wie een dossier verhuist,
-- mag dat blijven doen, maar het staat vanaf nu in de historiek.
-- ============================================================
do $$
declare
  v_firm uuid; v_ik uuid; v_ik_uid uuid := gen_random_uuid();
  v_baas uuid; v_baas_uid uuid := gen_random_uuid();
  v_t_a uuid; v_t_b uuid; v_klant uuid;
  v_n int; v_oud text; v_nieuw text;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_ik_uid, 's48@test.local', now()), (v_baas_uid, 's48-baas@test.local', now());
  insert into public.firms (naam) values ('S48 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, actief)
    values (v_firm, v_ik_uid, 'S48 Ik', 's48@x.be', 'medewerker', true) returning id into v_ik;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, actief)
    values (v_firm, v_baas_uid, 'S48 Beheerder', 's48-baas@x.be', 'kantoorbeheerder', true) returning id into v_baas;
  insert into public.teams (firm_id, code, naam, vestiging) values (v_firm, 'S48A', 'Team A', 'Aalst')
    returning id into v_t_a;
  insert into public.teams (firm_id, code, naam, vestiging) values (v_firm, 'S48B', 'Team B', 'Brussel')
    returning id into v_t_b;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id)
    values (v_firm, 'S48 Klant', 12, 31, 'geen', true, v_t_a) returning id into v_klant;

  perform set_config('taskflow.test_uid', v_ik_uid::text, true);

  -- 48.1 Verhuizen naar een ander team komt in de historiek.
  update public.clients set team_id = v_t_b where id = v_klant;

  select count(*), max(oude_waarde), max(nieuwe_waarde) into v_n, v_oud, v_nieuw
    from public.client_change_log where client_id = v_klant and veld = 'team_id';
  if v_n <> 1 then
    raise exception 'FAIL 48.1: de teamwissel liet % sporen na in plaats van 1', v_n;
  end if;
  if v_oud is distinct from v_t_a::text or v_nieuw is distinct from v_t_b::text then
    raise exception 'FAIL 48.1: het spoor noemt % -> % in plaats van % -> %', v_oud, v_nieuw, v_t_a, v_t_b;
  end if;
  raise notice 'PASS 48.1: een verhuizing naar een ander team staat in de historiek, met beide teams erbij';

  -- 48.2 Het team wegnemen is de gevaarlijkste variant -- dan ziet het hele
  -- kantoor het dossier -- en moet dus zeker een spoor nalaten. Sinds 0045 mag
  -- alleen een kantoorbeheerder dat nog; dat het spoor er dan staat, is precies
  -- wat hier getest wordt.
  perform set_config('taskflow.test_uid', v_baas_uid::text, true);
  update public.clients set team_id = null where id = v_klant;
  select count(*) into v_n from public.client_change_log
    where client_id = v_klant and veld = 'team_id' and nieuwe_waarde is null;
  if v_n <> 1 then
    raise exception 'FAIL 48.2: het wegnemen van het team liet % sporen na in plaats van 1', v_n;
  end if;
  raise notice 'PASS 48.2: het wegnemen van het team laat een spoor na';

  -- 48.3 Een wijziging die niets met zichtbaarheid te maken heeft, hoort geen
  -- teamregel in de historiek te zetten. Anders is het spoor ruis.
  update public.clients set naam = 'S48 Klant hernoemd' where id = v_klant;
  select count(*) into v_n from public.client_change_log
    where client_id = v_klant and veld = 'team_id';
  if v_n <> 2 then
    raise exception 'FAIL 48.3: een naamswijziging voegde een teamregel toe (% in plaats van 2)', v_n;
  end if;
  raise notice 'PASS 48.3: een gewone wijziging laat de teamhistoriek met rust';
end $$;


-- ============================================================
-- Sectie 49 (0045): alleen lopend werk opent een dossier, en het team
-- weghalen is een beheerdersbeslissing.
--
-- De gevaarlijkste van deze regels is niet dat er iets dichtgaat, maar WANNEER
-- het dichtgaat: wie zijn laatste taak op een dossier van een ander team
-- afwerkt, verliest daarmee de toegang -- mogelijk midden in die handeling
-- zelf. 49.3 gaat daar rechtstreeks op af. Zonder die test zou de regel er
-- correct uitzien en in de praktijk het afwerken van werk blokkeren.
-- ============================================================
do $$
declare
  v_firm uuid;
  v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_mw uuid;    v_mw_uid uuid := gen_random_uuid();
  v_t_mijn uuid; v_t_ander uuid;
  v_klant uuid; v_vertr uuid; v_eigen uuid;
  v_taak uuid; v_taak2 uuid; v_status text; v_n int; v_ok boolean;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_admin_uid, 's49-admin@test.local', now()), (v_mw_uid, 's49-mw@test.local', now());
  insert into public.firms (naam) values ('S49 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S49 Beheerder', 's49-admin@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'S49 Medewerker', 's49-mw@test.local', 'medewerker', false, true)
    returning id into v_mw;
  insert into public.teams (firm_id, code, naam, vestiging) values (v_firm, 'S49M', 'Mijn team', 'Aalst')
    returning id into v_t_mijn;
  insert into public.teams (firm_id, code, naam, vestiging) values (v_firm, 'S49A', 'Ander team', 'Antwerpen')
    returning id into v_t_ander;
  insert into public.employee_teams (employee_id, team_id) values (v_mw, v_t_mijn);

  -- Een dossier van het ANDERE team: enkel bereikbaar via werk.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id)
    values (v_firm, 'S49 Ander team', 12, 31, 'geen', true, v_t_ander) returning id into v_klant;

  -- Ad-hoc taken, met opzet: een wettelijke taak moet langs goedkeuring, en
  -- deze medewerker heeft dat recht niet. Voor de muur maakt de soort taak
  -- niets uit -- ze kijkt enkel naar wie ze op zijn naam heeft en of ze loopt.
  insert into public.task_instances (client_id, title, due_date, due_date_wettelijk,
                                     status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_klant, 'S49-1', current_date + 5, current_date + 5, 'open', v_mw, 'handmatig_adhoc', false)
    returning id into v_taak;
  insert into public.task_instances (client_id, title, due_date, due_date_wettelijk,
                                     status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_klant, 'S49-2', current_date + 6, current_date + 6, 'open', v_mw, 'handmatig_adhoc', false)
    returning id into v_taak2;

  -- 49.0 De fixture moet kloppen: lopend werk geeft toegang.
  if not public.can_view_client(v_klant, v_mw) then
    raise exception 'FAIL 49.0: lopend werk gaf geen toegang tot het dossier van het andere team';
  end if;
  raise notice 'PASS 49.0: lopend werk opent een dossier van een ander team';

  -- 49.1 Eén taak afwerken terwijl er nog een tweede loopt: toegang blijft.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  update public.task_instances set status = 'ingediend_afgerond' where id = v_taak;
  if not public.can_view_client(v_klant, v_mw) then
    raise exception 'FAIL 49.1: de toegang viel weg terwijl er nog lopend werk was';
  end if;
  raise notice 'PASS 49.1: zolang er lopend werk is, blijft het dossier open';

  -- 49.3 De handeling zelf mag niet blokkeren. Dit is de kern: de medewerker
  -- werkt zijn LAATSTE taak af, en die handeling beëindigt zijn eigen toegang
  -- tot het dossier. Doet de policy dat in de verkeerde volgorde, dan kan hij
  -- zijn werk niet afwerken.
  set local role authenticated;
  v_ok := true;
  begin
    update public.task_instances set status = 'ingediend_afgerond' where id = v_taak2;
    get diagnostics v_n = row_count;
    if v_n <> 1 then v_ok := false; end if;
  exception when others then v_ok := false;
  end;
  set local role postgres;
  if not v_ok then
    raise exception 'FAIL 49.3: de medewerker kon zijn laatste taak op dit dossier niet afwerken';
  end if;
  select status into v_status from public.task_instances where id = v_taak2;
  if v_status <> 'ingediend_afgerond' then
    raise exception 'FAIL 49.3: de laatste taak bleef op status %', v_status;
  end if;
  raise notice 'PASS 49.3: je kunt je laatste taak afwerken, ook al sluit dat het dossier voor je';

  -- 49.2 En daarna is het dossier dicht. (Na 49.3, want die heeft de laatste
  -- taak nodig.)
  if public.can_view_client(v_klant, v_mw) then
    raise exception 'FAIL 49.2: het dossier bleef open op afgewerkt werk';
  end if;
  raise notice 'PASS 49.2: afgewerkt werk houdt een dossier van een ander team niet langer open';

  -- 49.4 Hetzelfde voor een vertrouwelijk dossier, want dat is de scherpere kant.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  -- Een vertrouwelijk dossier moet een standaard verantwoordelijke hebben
  -- (controle uit 0009). Die staat los van de muur: hij bepaalt wie het werk
  -- krijgt, niet wie het dossier ziet.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime,
                              vertrouwelijk, standaard_verantwoordelijke_id, actief, team_id)
    values (v_firm, 'S49 Vertrouwelijk', 12, 31, 'geen', true, v_mw, true, v_t_mijn) returning id into v_vertr;
  insert into public.task_instances (client_id, title, due_date, due_date_wettelijk,
                                     status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_vertr, 'S49-V', current_date + 5, current_date + 5, 'open', v_mw, 'handmatig_adhoc', false)
    returning id into v_taak;
  if not public.can_view_client(v_vertr, v_mw) then
    raise exception 'FAIL 49.4: lopend werk gaf geen toegang tot het vertrouwelijke dossier';
  end if;
  update public.task_instances set status = 'ingediend_afgerond' where id = v_taak;
  if public.can_view_client(v_vertr, v_mw) then
    raise exception 'FAIL 49.4: een vertrouwelijk dossier bleef open op afgewerkt werk';
  end if;
  raise notice 'PASS 49.4: ook een vertrouwelijk dossier gaat dicht zodra het werk af is';

  -- 49.5 Je eigen afgewerkte taak blijft van jou: het dossier gaat dicht, je
  -- werk verdwijnt niet uit je eigen zicht.
  if not public.can_access_task_row(v_vertr, v_mw, 'ingediend_afgerond') then
    raise exception 'FAIL 49.5: de medewerker verloor zijn eigen afgewerkte taak uit het zicht';
  end if;
  raise notice 'PASS 49.5: het dossier gaat dicht, je eigen afgewerkte taak blijft van jou';

  -- Voor de teamregels een dossier dat deze medewerker ECHT ziet: in zijn eigen
  -- team, niet vertrouwelijk. Zonder dat zou RLS de update al tegenhouden en
  -- zou 49.6 groen worden zonder dat de trigger iets gedaan heeft.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id)
    values (v_firm, 'S49 Eigen team', 12, 31, 'geen', true, v_t_mijn) returning id into v_eigen;
  if not public.can_view_client(v_eigen, v_mw) then
    raise exception 'FAIL 49.6: fixture -- de medewerker ziet zijn eigen teamdossier niet';
  end if;

  -- 49.6 Het team weghalen mag een medewerker niet.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    update public.clients set team_id = null where id = v_eigen;
  exception when insufficient_privilege then v_ok := true;
  end;
  set local role postgres;
  if not v_ok then
    raise exception 'FAIL 49.6: een medewerker kon het team van een dossier weghalen';
  end if;
  raise notice 'PASS 49.6: het team weghalen is voorbehouden aan een kantoorbeheerder';

  -- 49.7 Verhuizen naar een team waar je ZELF in zit, blijft gewoon werk.
  -- Meervoudig lidmaatschap is normaal: een vennoot volgt twee teams op.
  insert into public.employee_teams (employee_id, team_id) values (v_mw, v_t_ander);
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  update public.clients set team_id = v_t_ander where id = v_eigen;
  get diagnostics v_n = row_count;
  set local role postgres;
  if v_n <> 1 then
    raise exception 'FAIL 49.7: verhuizen naar een eigen team raakte % rijen', v_n;
  end if;
  raise notice 'PASS 49.7: verhuizen tussen je eigen teams blijft dagelijks werk';

  -- 49.9 Maar niet naar een team waar je zelf NIET in zit. Dat volgt uit de
  -- policy zelf en niet uit een aparte controle: het gewijzigde dossier zou
  -- buiten je eigen bereik vallen, en dat weigert RLS. Het staat hier omdat
  -- het dragend is en nergens opgeschreven stond -- wie ooit de policy
  -- versoepelt, hoort hierop te stuiten.
  delete from public.employee_teams where employee_id = v_mw and team_id = v_t_mijn;
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  set local role authenticated;
  v_ok := false;
  begin
    update public.clients set team_id = v_t_mijn where id = v_eigen;
    get diagnostics v_n = row_count;
    if v_n = 0 then v_ok := true; end if;
  exception when insufficient_privilege then v_ok := true;
  end;
  set local role postgres;
  if not v_ok then
    raise exception 'FAIL 49.9: een medewerker kon een dossier naar een team duwen waar hij zelf niet in zit';
  end if;
  raise notice 'PASS 49.9: je kunt een dossier niet naar een team duwen waar je zelf niet in zit';

  -- 49.8 En een kantoorbeheerder mag het team wél weghalen.
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  update public.clients set team_id = null where id = v_eigen;
  select count(*) into v_n from public.clients where id = v_eigen and team_id is null;
  if v_n <> 1 then
    raise exception 'FAIL 49.8: de kantoorbeheerder kon het team niet weghalen';
  end if;
  raise notice 'PASS 49.8: een kantoorbeheerder mag het team wel weghalen';
end $$;


-- ============================================================
-- Sectie 50 (0046): de jaarlijkse UBO-bevestiging.
--
-- De wet geeft hier geen kalenderdatum -- ze zegt alleen "elk jaar", en een
-- wijziging binnen de maand. Het anker is daarom het boekjaar, op dezelfde
-- grens als de algemene vergadering. Wat deze sectie bewaakt is dat er ELK
-- jaar precies één valt, op die grens, en dat het anker met het boekjaar
-- meeschuift in plaats van voor iedereen op dezelfde dag te vallen.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_dec uuid; v_jun uuid; v_ot uuid;
  v_n int; v_due date; v_jaar int;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 's50@test.local', now());
  insert into public.firms (naam) values ('S50 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S50 Beheerder', 's50@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  -- Twee dossiers met een ander boekjaar: het anker moet meeschuiven.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S50 Boekjaar december', 12, 31, 'geen', true) returning id into v_dec;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S50 Boekjaar juni', 6, 30, 'geen', true) returning id into v_jun;

  select id into v_ot from public.obligation_types where code = 'ubo_bevestiging';
  if v_ot is null then
    raise exception 'FAIL 50.0: het verplichtingstype ubo_bevestiging bestaat niet';
  end if;

  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_dec, v_ot, true, date '2000-01-01'), (v_jun, v_ot, true, date '2000-01-01');

  perform public.generate_task_instances(24, 12);

  -- 50.1 Het boekjaar bepaalt de datum, niet de kalender. Let op het label:
  -- dat is het jaar van het BOEKJAAREINDE, terwijl de deadline een half jaar
  -- later valt. Voor een boekjaar dat op 31 december sluit, ligt de
  -- bevestiging dus in het jaar erna.
  v_jaar := extract(year from current_date)::int - 1;

  select due_date_wettelijk into v_due from public.task_instances
   where client_id = v_dec and obligation_type_id = v_ot and periode_label = v_jaar::text;
  if v_due is null then
    raise exception 'FAIL 50.1: geen UBO-taak voor boekjaar % van het december-dossier', v_jaar;
  end if;
  if v_due <> make_date(v_jaar + 1, 6, 30) then
    raise exception 'FAIL 50.1: december-boekjaar % gaf % in plaats van 30 juni %', v_jaar, v_due, v_jaar + 1;
  end if;

  -- 30 juni + 6 maanden is 30 december, niet 31: Postgres houdt de dag van de
  -- maand aan. Dat is precies wat de AV-tak ook doet, en die twee horen
  -- gelijk te lopen -- ze meten dezelfde wettelijke termijn.
  select due_date_wettelijk into v_due from public.task_instances
   where client_id = v_jun and obligation_type_id = v_ot and periode_label = v_jaar::text;
  if v_due <> (make_date(v_jaar, 6, 30) + interval '6 months')::date then
    raise exception 'FAIL 50.1: juni-boekjaar % gaf % in plaats van 30 december %', v_jaar, v_due, v_jaar;
  end if;
  raise notice 'PASS 50.1: de bevestiging valt zes maanden na het boekjaareinde en schuift dus mee met het boekjaar';

  -- 50.2 Precies één per jaar. Een verplichting die je "elk jaar" moet doen,
  -- mag niet twee keer in hetzelfde jaar opduiken en al helemaal niet
  -- overgeslagen worden.
  select count(*) into v_n from public.task_instances
   where client_id = v_dec and obligation_type_id = v_ot;
  if v_n < 2 then
    raise exception 'FAIL 50.2: maar % UBO-taken over het hele venster', v_n;
  end if;
  select count(*) into v_n from (
    select periode_label, count(*) as aantal from public.task_instances
     where client_id = v_dec and obligation_type_id = v_ot group by periode_label having count(*) > 1
  ) dubbel;
  if v_n <> 0 then
    raise exception 'FAIL 50.2: % jaren met meer dan één UBO-taak', v_n;
  end if;
  raise notice 'PASS 50.2: elk jaar precies één bevestiging, geen dubbele en geen gaten';

  -- 50.3 Een tweede generatieronde mag niets bijmaken. Zonder deze controle
  -- zou de maandelijkse onderhoudsronde de lijst stilaan verdubbelen.
  select count(*) into v_n from public.task_instances
   where client_id = v_dec and obligation_type_id = v_ot;
  perform public.generate_task_instances(24, 12);
  if (select count(*) from public.task_instances
       where client_id = v_dec and obligation_type_id = v_ot) <> v_n then
    raise exception 'FAIL 50.3: een tweede ronde maakte extra UBO-taken aan';
  end if;
  raise notice 'PASS 50.3: een tweede generatieronde maakt niets bij';

  -- 50.4 Ze hoort in de werkstroom van de afsluiting: daar wordt de
  -- aandeelhoudersstructuur toch al nagekeken.
  if (select werkstroom from public.obligation_types where id = v_ot) <> 'afsluiting' then
    raise exception 'FAIL 50.4: de UBO-bevestiging staat niet in de werkstroom afsluiting';
  end if;
  if (select categorie from public.obligation_types where id = v_ot) <> 'wettelijk' then
    raise exception 'FAIL 50.4: de UBO-bevestiging staat niet als wettelijke verplichting';
  end if;
  raise notice 'PASS 50.4: wettelijk, en in de werkstroom van de afsluiting';
end $$;


-- ============================================================
-- Sectie 51 (0047): sinds wanneer wacht dit dossier op de klant?
--
-- De kolom moet drie dingen doen en één ding niet doen. Ze moet gezet worden
-- bij het binnengaan, gewist bij het verlaten, opnieuw gezet bij een tweede
-- wachtbeurt -- en ze mag NIET door een medewerker zelf te zetten zijn. Dat
-- laatste is het punt: kan iemand de wachttijd terugzetten, dan ziet een
-- dossier dat al maanden ligt er jong uit, en dat is precies de kant waarop
-- het niet mag liegen.
-- ============================================================
do $$
declare
  v_firm uuid; v_mw uuid; v_mw_uid uuid := gen_random_uuid();
  v_klant uuid; v_taak uuid;
  v_sinds timestamptz; v_eerste timestamptz; v_n int;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_mw_uid, 's51@test.local', now());
  insert into public.firms (naam) values ('S51 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'S51 Medewerker', 's51@test.local', 'medewerker', true, true)
    returning id into v_mw;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S51 Klant', 12, 31, 'geen', true) returning id into v_klant;

  insert into public.task_instances (client_id, title, due_date, due_date_wettelijk,
                                     status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_klant, 'S51 Taak', current_date + 10, current_date + 10, 'open', v_mw, 'handmatig_adhoc', false)
    returning id into v_taak;

  perform set_config('taskflow.test_uid', v_mw_uid::text, true);

  -- 51.1 Een taak die nog niet wacht, draagt geen stempel.
  select wacht_op_klant_sinds into v_sinds from public.task_instances where id = v_taak;
  if v_sinds is not null then
    raise exception 'FAIL 51.1: een open taak droeg al een wachtstempel';
  end if;

  -- 51.2 Binnengaan zet de stempel.
  update public.task_instances set status = 'wacht_op_klant' where id = v_taak;
  select wacht_op_klant_sinds into v_eerste from public.task_instances where id = v_taak;
  if v_eerste is null then
    raise exception 'FAIL 51.2: het binnengaan van wacht_op_klant zette geen stempel';
  end if;
  raise notice 'PASS 51.1/51.2: de stempel verschijnt precies bij het binnengaan';

  -- 51.3 Verlaten wist de stempel. Anders zou een taak die allang weer loopt,
  -- op het scherm nog altijd als wachtend tellen.
  update public.task_instances set status = 'in_uitvoering' where id = v_taak;
  select wacht_op_klant_sinds into v_sinds from public.task_instances where id = v_taak;
  if v_sinds is not null then
    raise exception 'FAIL 51.3: de stempel bleef staan na het verlaten van de status';
  end if;
  raise notice 'PASS 51.3: het verlaten van de status wist de stempel';

  -- 51.4 Een tweede wachtbeurt zet de stempel opnieuw.
  --
  -- Let op wat hier NIET getest kan worden: dat de tweede stempel later is dan
  -- de eerste. `now()` is transactiegebonden, dus binnen dit blok dragen alle
  -- stempels dezelfde tijd. Een `<` erop zou altijd falen en een `<=` zou
  -- altijd slagen -- in beide gevallen zonder iets te bewijzen.
  --
  -- Het echte bewijs zit in 51.3: de stempel wordt gewist bij het verlaten.
  -- Daardoor kan er bij het opnieuw binnengaan niets ouds blijven staan, ook
  -- niet als iemand hier later een coalesce(old, now()) van maakt.
  update public.task_instances set status = 'wacht_op_klant' where id = v_taak;
  select wacht_op_klant_sinds into v_sinds from public.task_instances where id = v_taak;
  if v_sinds is null then
    raise exception 'FAIL 51.4: de tweede wachtbeurt zette geen stempel';
  end if;
  select count(*) into v_n from public.task_status_log
   where task_instance_id = v_taak and nieuw_status = 'wacht_op_klant';
  if v_n <> 2 then
    raise exception 'FAIL 51.4: het logboek telde % keer binnengaan in plaats van 2', v_n;
  end if;
  raise notice 'PASS 51.4: een tweede wachtbeurt zet de stempel opnieuw, en het logboek houdt beide beurten bij';

  -- 51.5 De stempel is eigendom van de trigger. Wie hem met de hand
  -- terugzet, hoort hem te zien terugspringen -- anders is de teller
  -- waardeloos precies bij het dossier dat te lang ligt.
  update public.task_instances
     set wacht_op_klant_sinds = now() - interval '1 day'
   where id = v_taak;
  select wacht_op_klant_sinds into v_eerste from public.task_instances where id = v_taak;
  if v_eerste <> v_sinds then
    raise exception 'FAIL 51.5: een medewerker kon de wachtstempel zelf verzetten naar %', v_eerste;
  end if;
  raise notice 'PASS 51.5: de stempel is niet met de hand te verzetten';
end $$;


-- ============================================================
-- Sectie 52 (0048): de btw-kwartaaldeadline schuift niet meer op.
--
-- De data hieronder komen letterlijk uit de btw-kalender 2026 van de FOD.
-- Ze zijn met opzet vast ingetypt en niet berekend: een test die dezelfde
-- formule herhaalt als de motor, bewijst alleen dat de formule zichzelf
-- gelijk is.
--
--   periodieke kwartaalaangiften   Q1-2026  27.04.2026   (laatste keer verschoven)
--                                  Q2-2026  25.07.2026   zaterdag, geen uitstel
--                                  Q3-2026  25.10.2026   zondag,   geen uitstel
--   maandelijkse aangiften         mei 2026 22.06.2026   nog steeds verschoven
--   bijzondere aangiften           Q3-2026  25.10.2026   zondag, nooit verschoven
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_kwartaal uuid; v_maand uuid; v_bijz uuid;
  v_ot_btw uuid; v_ot_bijz uuid;
  v_wettelijk date; v_werk date;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 's52@test.local', now());
  insert into public.firms (naam) values ('S52 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S52 Beheerder', 's52@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S52 Kwartaalaangever', 12, 31, 'periodieke_aangever', 'kwartaal', true) returning id into v_kwartaal;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S52 Maandaangever', 12, 31, 'periodieke_aangever', 'maand', true) returning id into v_maand;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S52 Vrijgesteld', 12, 31, 'vrijgesteld_kleine_onderneming', true) returning id into v_bijz;

  select id into v_ot_btw from public.obligation_types where code = 'btw_aangifte';
  select id into v_ot_bijz from public.obligation_types where code = 'btw_bijzondere_aangifte';
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf) values
    (v_bijz, v_ot_bijz, true, date '2000-01-01');

  -- De btw-verplichting wordt door de trigger van 0004 aangemaakt met
  -- geldig_vanaf = vandaag, en de motor genereert niets van voor die datum.
  -- Voor 52.2 en 52.3 zijn juist de afgelopen kwartalen nodig.
  update public.client_obligations set geldig_vanaf = date '2000-01-01'
   where client_id in (v_kwartaal, v_maand);

  perform public.generate_task_instances(24, 24);

  -- 52.1 Q3-2026 valt op zondag 25 oktober en schuift NIET meer vooruit.
  select due_date_wettelijk, due_date into v_wettelijk, v_werk
    from public.task_instances
   where client_id = v_kwartaal and obligation_type_id = v_ot_btw and periode_label = '2026-Q3';
  if v_wettelijk is distinct from date '2026-10-25' then
    raise exception 'FAIL 52.1: de wettelijke datum van Q3-2026 is % i.p.v. 25/10/2026', v_wettelijk;
  end if;
  if v_werk is distinct from date '2026-10-23' then
    raise exception 'FAIL 52.1: de werkdatum van Q3-2026 is % i.p.v. vrijdag 23/10/2026', v_werk;
  end if;
  raise notice 'PASS 52.1: een zondagdeadline plant op de vrijdag ervoor, met de wet ernaast';

  -- 52.2 Q1-2026 schoof nog wél vooruit. De regel is pas daarna veranderd, en
  -- het systeem mag niet liegen over het verleden.
  select due_date into v_werk from public.task_instances
   where client_id = v_kwartaal and obligation_type_id = v_ot_btw and periode_label = '2026-Q1';
  if v_werk is distinct from date '2026-04-27' then
    raise exception 'FAIL 52.2: Q1-2026 staat op % i.p.v. maandag 27/04/2026', v_werk;
  end if;
  raise notice 'PASS 52.2: de kanteldatum wordt gerespecteerd, oudere kwartalen schuiven nog vooruit';

  -- 52.3 De maandaangever schuift wél nog vooruit. Dat is geen inconsistentie
  -- van ons: zo publiceert de FOD het.
  select due_date_wettelijk, due_date into v_wettelijk, v_werk
    from public.task_instances
   where client_id = v_maand and obligation_type_id = v_ot_btw and periode_label = '2026-05';
  if v_wettelijk is distinct from date '2026-06-20' then
    raise exception 'FAIL 52.3: de wettelijke datum van mei 2026 is % i.p.v. 20/06/2026', v_wettelijk;
  end if;
  if v_werk is distinct from date '2026-06-22' then
    raise exception 'FAIL 52.3: de maandaangifte van mei 2026 staat op % i.p.v. maandag 22/06/2026', v_werk;
  end if;
  raise notice 'PASS 52.3: de maandaangifte schuift onveranderd vooruit';

  -- 52.4 De bijzondere aangifte schoof nooit mee, ook niet voor de kanteldatum.
  select due_date_wettelijk, due_date into v_wettelijk, v_werk
    from public.task_instances
   where client_id = v_bijz and obligation_type_id = v_ot_bijz and periode_label = '2026-Q3';
  if v_wettelijk is distinct from date '2026-10-25' then
    raise exception 'FAIL 52.4: de wettelijke datum van de bijzondere aangifte Q3-2026 is %', v_wettelijk;
  end if;
  if v_werk is distinct from date '2026-10-23' then
    raise exception 'FAIL 52.4: de bijzondere aangifte Q3-2026 staat op % i.p.v. vrijdag 23/10/2026', v_werk;
  end if;
  raise notice 'PASS 52.4: de bijzondere aangifte schuift ook achteruit';

  -- 52.5 vorige_werkdag() slaat feestdagen over, niet alleen weekends.
  -- 1 mei 2026 is een vrijdag én Dag van de Arbeid; de werkdag ervoor is
  -- donderdag 30 april.
  if public.vorige_werkdag(date '2026-05-02') is distinct from date '2026-04-30' then
    raise exception 'FAIL 52.5: vorige_werkdag(02/05/2026) gaf % i.p.v. 30/04/2026',
      public.vorige_werkdag(date '2026-05-02');
  end if;
  -- Een gewone werkdag blijft zichzelf.
  if public.vorige_werkdag(date '2026-10-23') is distinct from date '2026-10-23' then
    raise exception 'FAIL 52.5: vorige_werkdag() verzette een gewone werkdag';
  end if;
  raise notice 'PASS 52.5: vorige_werkdag() slaat weekends en feestdagen over en laat werkdagen staan';
end $$;


-- ============================================================
-- Sectie 53 (0049): fiche 281.50 valt op 29 juni.
--
-- "Vóór 30 juni" is ten laatste de 29ste. De FOD publiceert het ook zo:
-- voor inkomstenjaar 2025 stond het aangekondigd als "uiterlijk op maandag
-- 29 juni 2026". Deze sectie bewaakt meteen dat de fiches 281.20 en 281.45
-- NIET meeschuiven -- die vallen eind februari en dat klopte al.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_klant uuid; v_ot_50 uuid; v_ot_20 uuid;
  v_due date; v_jaar int := extract(year from current_date)::int;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 's53@test.local', now());
  insert into public.firms (naam) values ('S53 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S53 Beheerder', 's53@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S53 Klant', 12, 31, 'geen', true) returning id into v_klant;

  select id into v_ot_50 from public.obligation_types where code = 'fiche_281_50';
  select id into v_ot_20 from public.obligation_types where code = 'fiche_281_20';
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf) values
    (v_klant, v_ot_50, true, date '2000-01-01'),
    (v_klant, v_ot_20, true, date '2000-01-01');

  perform public.generate_task_instances(24, 12);

  -- 53.1 De 29ste, niet de 30ste.
  select due_date_wettelijk into v_due from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_50 and periode_label = v_jaar::text;
  if v_due is null then
    raise exception 'FAIL 53.1: geen 281.50-taak voor inkomstenjaar %', v_jaar;
  end if;
  if v_due is distinct from make_date(v_jaar + 1, 6, 29) then
    raise exception 'FAIL 53.1: fiche 281.50 van % staat op % i.p.v. 29 juni %', v_jaar, v_due, v_jaar + 1;
  end if;
  raise notice 'PASS 53.1: fiche 281.50 valt op 29 juni';

  -- 53.2 De fiches van eind februari blijven waar ze stonden. Die rekent 0028
  -- als "1 maart min een dag", wat ook in een schrikkeljaar juist is.
  select due_date_wettelijk into v_due from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_20 and periode_label = v_jaar::text;
  if v_due is distinct from (make_date(v_jaar + 1, 3, 1) - 1) then
    raise exception 'FAIL 53.2: fiche 281.20 van % staat op % i.p.v. eind februari %', v_jaar, v_due, v_jaar + 1;
  end if;
  raise notice 'PASS 53.2: de fiches van eind februari zijn niet meeverschoven';
end $$;


-- ============================================================
-- Sectie 54 (0050): de intracommunautaire opgave.
--
-- De data komen uit de btw-kalender 2026 van de FOD en staan hier vast
-- ingetypt:
--
--   kwartaalopgave  Q1-2026  25.04.2026 (zaterdag, geen uitstel)
--                   Q3-2026  25.10.2026 (zondag,   geen uitstel)
--   maandopgave     mei 2026 22.06.2026 (20 juni is een zaterdag, wel uitstel)
--
-- Let op het contrast dat deze sectie bewaakt: de kwartaalopgave stond in
-- diezelfde kalender op 25.04.2026 terwijl de periodieke kwartaalAANGIFTE
-- 27.04.2026 kreeg. Twee verplichtingen, dezelfde dag, een ander antwoord.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_kw uuid; v_maa uuid; v_ot uuid;
  v_wet date; v_werk date; v_n int;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 's54@test.local', now());
  insert into public.firms (naam) values ('S54 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S54 Beheerder', 's54@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S54 Kwartaalaangever', 12, 31, 'periodieke_aangever', 'kwartaal', true) returning id into v_kw;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S54 Maandaangever', 12, 31, 'periodieke_aangever', 'maand', true) returning id into v_maa;

  select id into v_ot from public.obligation_types where code = 'ic_opgave';
  if v_ot is null then
    raise exception 'FAIL 54.0: het verplichtingstype ic_opgave bestaat niet';
  end if;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf) values
    (v_kw, v_ot, true, date '2000-01-01'),
    (v_maa, v_ot, true, date '2000-01-01');

  perform public.generate_task_instances(24, 24);

  -- 54.1 De frequentie volgt standaard het btw-ritme van de klant.
  select count(*) into v_n from public.task_instances
   where client_id = v_kw and obligation_type_id = v_ot and periode_label like '%-Q%';
  if v_n = 0 then
    raise exception 'FAIL 54.1: de kwartaalaangever kreeg geen kwartaalopgaven';
  end if;
  select count(*) into v_n from public.task_instances
   where client_id = v_maa and obligation_type_id = v_ot and periode_label ~ '^\d{4}-\d{2}$';
  if v_n = 0 then
    raise exception 'FAIL 54.1: de maandaangever kreeg geen maandopgaven';
  end if;
  raise notice 'PASS 54.1: de opgave volgt het btw-ritme van het dossier';

  -- 54.2 De kwartaalopgave schuift NIET op. Q3-2026 valt op zondag 25 oktober.
  select due_date_wettelijk, due_date into v_wet, v_werk from public.task_instances
   where client_id = v_kw and obligation_type_id = v_ot and periode_label = '2026-Q3';
  if v_wet is distinct from date '2026-10-25' then
    raise exception 'FAIL 54.2: de wettelijke datum van de kwartaalopgave Q3-2026 is %', v_wet;
  end if;
  if v_werk is distinct from date '2026-10-23' then
    raise exception 'FAIL 54.2: de kwartaalopgave Q3-2026 staat op % i.p.v. vrijdag 23/10/2026', v_werk;
  end if;

  -- En ook niet vóór de kanteldatum van de gewone aangifte: de opgave is
  -- nooit meeverschoven. Q1-2026 viel op zaterdag 25 april, terwijl de
  -- periodieke kwartaalaangifte die dag 27 april kreeg.
  select due_date_wettelijk, due_date into v_wet, v_werk from public.task_instances
   where client_id = v_kw and obligation_type_id = v_ot and periode_label = '2026-Q1';
  if v_wet is distinct from date '2026-04-25' then
    raise exception 'FAIL 54.2: de wettelijke datum van de kwartaalopgave Q1-2026 is %', v_wet;
  end if;
  if v_werk is distinct from date '2026-04-24' then
    raise exception 'FAIL 54.2: de kwartaalopgave Q1-2026 staat op % i.p.v. vrijdag 24/04/2026', v_werk;
  end if;
  raise notice 'PASS 54.2: de kwartaalopgave schuift nooit vooruit, ook niet voor de kanteldatum';

  -- 54.3 De maandopgave schuift wél vooruit, net als de maandaangifte.
  select due_date_wettelijk, due_date into v_wet, v_werk from public.task_instances
   where client_id = v_maa and obligation_type_id = v_ot and periode_label = '2026-05';
  if v_wet is distinct from date '2026-06-20' then
    raise exception 'FAIL 54.3: de wettelijke datum van de maandopgave mei 2026 is %', v_wet;
  end if;
  if v_werk is distinct from date '2026-06-22' then
    raise exception 'FAIL 54.3: de maandopgave mei 2026 staat op % i.p.v. maandag 22/06/2026', v_werk;
  end if;
  raise notice 'PASS 54.3: de maandopgave schuift wel vooruit';

  -- 54.4 Het kantoor kan per dossier afwijken. De echte regel is een drempel
  -- van 50.000 euro per kwartaal, en die kent Taskflow niet.
  update public.client_obligations
     set parameters = jsonb_build_object('frequentie', 'maand')
   where client_id = v_kw and obligation_type_id = v_ot;
  perform public.generate_task_instances(24, 24);

  select count(*) into v_n from public.task_instances
   where client_id = v_kw and obligation_type_id = v_ot and periode_label ~ '^\d{4}-\d{2}$';
  if v_n = 0 then
    raise exception 'FAIL 54.4: de kwartaalaangever kreeg na de parameterwijziging geen maandopgaven';
  end if;
  raise notice 'PASS 54.4: een dossier boven de drempel kan op maandopgave gezet worden';

  -- 54.5 Ze hoort in de btw-werkstroom, daar wordt ze samen met de aangifte
  -- afgewerkt.
  if (select werkstroom from public.obligation_types where id = v_ot) <> 'btw' then
    raise exception 'FAIL 54.5: de IC-opgave staat niet in de btw-werkstroom';
  end if;
  raise notice 'PASS 54.5: de IC-opgave staat in de btw-werkstroom';
end $$;


-- ============================================================
-- Sectie 55 (0051): de kwartaalaangifte bedrijfsvoorheffing.
--
-- De data komen uit de kalender bedrijfsvoorheffing van de FOD en staan hier
-- vast ingetypt:
--
--   Q4-2025  15.01.2026     Q1-2026  15.04.2026
--   Q2-2026  15.07.2026     Q3-2026  15.10.2026
--   Q4-2026  15.01.2027
--
-- Alle vijf een werkdag, dus die tabel bewijst niets over het weekendgeval.
-- 15.01.2028 en 15.04.2028 zijn wél zaterdagen, en die zitten binnen de
-- horizon. 55.3 gaat daar rechtstreeks op af.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_klant uuid; v_ot uuid;
  v_wet date; v_werk date; v_n int;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 's55@test.local', now());
  insert into public.firms (naam) values ('S55 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S55 Beheerder', 's55@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S55 Werkgever', 12, 31, 'geen', true) returning id into v_klant;

  select id into v_ot from public.obligation_types where code = 'bedrijfsvoorheffing';
  if v_ot is null then
    raise exception 'FAIL 55.0: het verplichtingstype bedrijfsvoorheffing bestaat niet';
  end if;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_klant, v_ot, true, date '2000-01-01');

  perform public.generate_task_instances(30, 24);

  -- 55.1 De 15de van de maand na het kwartaal, letterlijk zoals de FOD ze
  -- publiceert.
  select due_date_wettelijk into v_wet from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot and periode_label = '2026-Q1';
  if v_wet is distinct from date '2026-04-15' then
    raise exception 'FAIL 55.1: Q1-2026 staat op % i.p.v. 15/04/2026', v_wet;
  end if;
  select due_date_wettelijk into v_wet from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot and periode_label = '2026-Q4';
  if v_wet is distinct from date '2027-01-15' then
    raise exception 'FAIL 55.1: Q4-2026 staat op % i.p.v. 15/01/2027', v_wet;
  end if;
  raise notice 'PASS 55.1: de kwartaalaangifte valt op de 15de van de maand erna';

  -- 55.2 Vier per jaar, geen dubbele en geen gaten.
  --
  -- Wat dit NIET bewijst: de stap van de lus. Zet je de generate_series op
  -- één maand in plaats van drie, dan blijft de uitkomst identiek -- het
  -- kwartaallabel botst en `on conflict do nothing` laat de eerste rij staan.
  -- Die mutatie is dus onzichtbaar aan de buitenkant, en er is geen test die
  -- ze kan vangen zonder iets te beweren wat de gebruiker niet ziet.
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot and periode_label like '2026-Q%';
  if v_n <> 4 then
    raise exception 'FAIL 55.2: % taken voor 2026 in plaats van 4', v_n;
  end if;
  raise notice 'PASS 55.2: vier aangiftes per jaar';

  -- 55.3 De zaterdag van 15 januari 2028: de werkdatum gaat naar de vrijdag
  -- ERVOOR, niet naar de maandag erna. De maandkalender van de FOD toont
  -- diezelfde richting (13.02, 13.03, 14.08, 13.11 in 2026: telkens
  -- vervroegd), en het kantoor koos die richting al voor de btw.
  select due_date_wettelijk, due_date into v_wet, v_werk from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot and periode_label = '2027-Q4';
  if v_wet is null then
    raise exception 'FAIL 55.3: geen taak voor Q4-2027 binnen de horizon';
  end if;
  if v_wet is distinct from date '2028-01-15' then
    raise exception 'FAIL 55.3: de wettelijke datum van Q4-2027 is % i.p.v. 15/01/2028', v_wet;
  end if;
  if v_werk is distinct from date '2028-01-14' then
    raise exception 'FAIL 55.3: 15/01/2028 is een zaterdag; de werkdatum is % i.p.v. vrijdag 14/01/2028', v_werk;
  end if;
  raise notice 'PASS 55.3: een zaterdagdeadline plant op de vrijdag ervoor';

  -- 55.4 Ze staat bij het werk rond loon, waar ook de fiches 281 zitten.
  if (select werkstroom from public.obligation_types where id = v_ot) <> 'fiches' then
    raise exception 'FAIL 55.4: de bedrijfsvoorheffing staat niet bij het loonwerk';
  end if;
  raise notice 'PASS 55.4: de bedrijfsvoorheffing staat bij het werk rond loon';
end $$;

-- ============================================================
-- Sectie 56 (0052): een gewijzigd boekjaareinde.
--
-- Het gedrag dat deze sectie vastlegt is precies wat er vóór 0052 STIL
-- misging: de jaartaken bleven op het oude boekjaar staan zonder dat iets
-- daarop wees. Elke test hieronder is dus even goed een test op de melding
-- als op het herrekenen.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_klant uuid; v_ot_jaar uuid; v_ot_pb uuid;
  v_w uuid; v_n int; v_aantal int;
  v_due date; v_eind date; v_status public.task_status;
  v_taak uuid; v_herzetbaar boolean; v_reden text;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 's56@test.local', now());
  insert into public.firms (naam) values ('S56 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S56 Beheerder', 's56@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S56 Klant', 12, 31, 'geen', true) returning id into v_klant;

  select id into v_ot_jaar from public.obligation_types where code = 'jaarafsluiting';
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters)
    values (v_klant, v_ot_jaar, true, date '2000-01-01', '{"sla_maanden": 3}'::jsonb);

  perform public.generate_task_instances(24, 0);

  -- 56.0 Voorwaarde: er staan taken op het oude boekjaar.
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_jaar and status = 'open';
  if v_n < 2 then
    raise exception 'FAIL 56.0: verwacht minstens twee open jaarafsluitingen, kreeg %', v_n;
  end if;

  -- ---------------------------------------------------------
  -- 56.1 Het boekjaar verzetten meldt, en herrekent NIET.
  -- ---------------------------------------------------------
  update public.clients set boekjaar_einde_maand = 6, boekjaar_einde_dag = 30 where id = v_klant;

  select id into v_w from public.boekjaar_wijzigingen where client_id = v_klant and status = 'open';
  if v_w is null then
    raise exception 'FAIL 56.1: een gewijzigd boekjaareinde levert geen openstaande melding op';
  end if;

  select due_date into v_due from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_jaar
     and periode_label = '2026' and status = 'open';
  if v_due is distinct from date '2027-03-31' then
    raise exception 'FAIL 56.1: de taak van 2026 is al herrekend (%) terwijl er nog niemand goedgekeurd heeft', v_due;
  end if;
  raise notice 'PASS 56.1: de wijziging wordt gemeld en niets wordt stil herrekend';

  -- ---------------------------------------------------------
  -- 56.2 De lijst toont wat er op het oude ritme staat.
  -- ---------------------------------------------------------
  select count(*) into v_n from public.boekjaar_wijziging_taken(v_w);
  if v_n < 2 then
    raise exception 'FAIL 56.2: de lijst toont % taken, verwacht minstens twee', v_n;
  end if;
  select count(*) into v_n from public.boekjaar_wijziging_taken(v_w) t where t.herzetbaar;
  if v_n < 2 then
    raise exception 'FAIL 56.2: % van die taken is herzetbaar, verwacht minstens twee', v_n;
  end if;
  raise notice 'PASS 56.2: de geraakte taken staan in de lijst, met hun herzetbaarheid';

  -- ---------------------------------------------------------
  -- 56.3 Een handmatig afgesproken deadline blijft staan.
  --
  -- Die afspraak is met de klant gemaakt. De motor mag ze niet overschrijven,
  -- en de lijst moet dat ook zeggen in plaats van de taak stil weg te laten.
  -- ---------------------------------------------------------
  select id into v_taak from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_jaar
     and periode_label = '2027' and status = 'open';
  perform set_config('taskflow.pipeline_task_id', '', true);
  update public.task_instances
  set due_date = date '2028-02-15', due_date_handmatig_op = now()
  where id = v_taak;

  select t.herzetbaar, t.reden into v_herzetbaar, v_reden
  from public.boekjaar_wijziging_taken(v_w) t where t.task_id = v_taak;
  if v_herzetbaar is null then
    raise exception 'FAIL 56.3: de taak met een handmatige datum staat niet in de lijst';
  end if;
  if v_herzetbaar then
    raise exception 'FAIL 56.3: een handmatig afgesproken deadline wordt als herzetbaar getoond';
  end if;
  if v_reden is null or position('handmatig' in v_reden) = 0 then
    raise exception 'FAIL 56.3: de reden noemt de handmatige afspraak niet (%)', coalesce(v_reden, 'niets');
  end if;
  raise notice 'PASS 56.3: een handmatig afgesproken deadline wordt getoond maar niet herzet';

  -- ---------------------------------------------------------
  -- 56.4 Doorvoeren zet de taken op het nieuwe boekjaar.
  -- ---------------------------------------------------------
  v_aantal := public.boekjaar_wijziging_toepassen(v_w);
  if v_aantal < 1 then
    raise exception 'FAIL 56.4: er is niets herzet';
  end if;

  select periode_eind, due_date into v_eind, v_due from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_jaar
     and periode_label = '2026' and status = 'open';
  if v_eind is distinct from date '2026-06-30' then
    raise exception 'FAIL 56.4: de taak van 2026 eindigt op % i.p.v. 30/06/2026', v_eind;
  end if;
  if v_due is distinct from date '2026-09-30' then
    raise exception 'FAIL 56.4: de deadline van 2026 is % i.p.v. 30/09/2026', v_due;
  end if;

  -- De oude taak is er nog, geannuleerd. Verwijderen zou de geschiedenis van
  -- het dossier uithollen.
  select status into v_status from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_jaar
     and periode_label = '2026' and periode_eind = date '2026-12-31';
  if v_status is distinct from 'geannuleerd' then
    raise exception 'FAIL 56.4: de oude taak van 2026 heeft status % i.p.v. geannuleerd', coalesce(v_status::text, 'niets');
  end if;
  raise notice 'PASS 56.4: doorvoeren zet de taken op het nieuwe boekjaar en bewaart de oude';

  -- 56.5 De taak met de handmatige afspraak is niet aangeraakt.
  select due_date, status into v_due, v_status from public.task_instances where id = v_taak;
  if v_status is distinct from 'open' or v_due is distinct from date '2028-02-15' then
    raise exception 'FAIL 56.5: de handmatig afgesproken taak is toch gewijzigd (% op %)', v_status, v_due;
  end if;
  raise notice 'PASS 56.5: de handmatig afgesproken taak is ongemoeid gelaten';

  -- 56.6 De melding is afgehandeld en kan niet twee keer doorgevoerd worden.
  select status::text into v_reden from public.boekjaar_wijzigingen where id = v_w;
  if v_reden <> 'doorgevoerd' then
    raise exception 'FAIL 56.6: de melding staat op % i.p.v. doorgevoerd', v_reden;
  end if;
  begin
    perform public.boekjaar_wijziging_toepassen(v_w);
    raise exception 'FAIL 56.6: een afgehandelde melding liet zich opnieuw doorvoeren';
  exception when check_violation then
    null;
  end;
  raise notice 'PASS 56.6: een melding wordt hoogstens één keer doorgevoerd';

  -- ---------------------------------------------------------
  -- 56.7 Terug naar het oorspronkelijke boekjaar laat niets te beslissen over.
  -- ---------------------------------------------------------
  update public.clients set boekjaar_einde_maand = 3, boekjaar_einde_dag = 31 where id = v_klant;
  update public.clients set boekjaar_einde_maand = 6, boekjaar_einde_dag = 30 where id = v_klant;
  select count(*) into v_n from public.boekjaar_wijzigingen
   where client_id = v_klant and status = 'open';
  if v_n <> 0 then
    raise exception 'FAIL 56.7: er blijft een melding open nadat het boekjaar terug op zijn oude waarde staat (%)', v_n;
  end if;
  raise notice 'PASS 56.7: heen en terug laat geen melding achter';

  -- ---------------------------------------------------------
  -- 56.8 De aangifte personenbelasting hangt NIET aan het boekjaar.
  --
  -- Dat is de scherpe kant van de vlag: een vaste kalenderdatum voor een
  -- natuurlijke persoon verandert niet mee met het boekjaar van zijn zaak.
  -- ---------------------------------------------------------
  select id into v_ot_pb from public.obligation_types where code = 'aangifte_pb';
  if (select volgt_boekjaar from public.obligation_types where id = v_ot_pb) then
    raise exception 'FAIL 56.8: de aangifte personenbelasting staat als boekjaarvolgend gemarkeerd';
  end if;
  select count(*) into v_n from public.obligation_types
   where volgt_boekjaar and code not in (
     'algemene_vergadering', 'jaarafsluiting', 'ubo_bevestiging', 'va_venb',
     'aangifte_venb_pb', 'aangifte_rpb', 'neerlegging_jaarrekening');
  if v_n <> 0 then
    raise exception 'FAIL 56.8: % verplichting(en) staan onverwacht als boekjaarvolgend gemarkeerd', v_n;
  end if;
  raise notice 'PASS 56.8: alleen de verplichtingen die het boekjaareinde gebruiken zijn gemarkeerd';
end $$;

-- ------------------------------------------------------------
-- 56.9 De drie functies zijn `security definer` en dus API-aanroepbaar.
--      Wie het dossier niet mag zien, mag ze ook niet gebruiken -- ook niet
--      met een geldig meldings-id in de hand.
-- ------------------------------------------------------------
do $$
declare
  v_firm uuid; v_klant uuid; v_ot uuid; v_w uuid;
  v_beheerder uuid; v_beheerder_uid uuid := gen_random_uuid();
  v_vreemde uuid; v_vreemde_uid uuid := gen_random_uuid();
  v_team_a uuid; v_team_b uuid;
  v_n int;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_beheerder_uid, 's569a@test.local', now()),
    (v_vreemde_uid, 's569b@test.local', now());
  insert into public.firms (naam) values ('S56.9 Kantoor') returning id into v_firm;
  insert into public.teams (firm_id, code, naam, vestiging) values
    (v_firm, 'S69A', 'S56.9 Team A', 'Aalst') returning id into v_team_a;
  insert into public.teams (firm_id, code, naam, vestiging) values
    (v_firm, 'S69B', 'S56.9 Team B', 'Zaventem') returning id into v_team_b;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_beheerder_uid, 'Beheerder', 's569a@test.local', 'kantoorbeheerder', true, true)
    returning id into v_beheerder;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_vreemde_uid, 'Ander team', 's569b@test.local', 'medewerker', false, true)
    returning id into v_vreemde;
  insert into public.employee_teams (employee_id, team_id) values
    (v_beheerder, v_team_a), (v_vreemde, v_team_b);

  perform set_config('taskflow.test_uid', v_beheerder_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id)
    values (v_firm, 'S56.9 Klant', 12, 31, 'geen', true, v_team_a) returning id into v_klant;
  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters)
    values (v_klant, v_ot, true, date '2000-01-01', '{"sla_maanden": 3}'::jsonb);
  perform public.generate_task_instances(24, 0);
  update public.clients set boekjaar_einde_maand = 6, boekjaar_einde_dag = 30 where id = v_klant;
  select id into v_w from public.boekjaar_wijzigingen where client_id = v_klant and status = 'open';

  -- Nu als de medewerker uit het andere team, met het id in de hand.
  perform set_config('taskflow.test_uid', v_vreemde_uid::text, true);
  set local role authenticated;

  -- De tabel zelf: de melding hoort niet zichtbaar te zijn.
  select count(*) into v_n from public.boekjaar_wijzigingen where id = v_w;
  if v_n <> 0 then
    raise exception 'FAIL 56.9: de melding is zichtbaar voor een medewerker uit een ander team';
  end if;

  begin
    perform * from public.boekjaar_wijziging_taken(v_w);
    raise exception 'FAIL 56.9: boekjaar_wijziging_taken() gaf de lijst vrij aan een vreemde';
  exception when insufficient_privilege then
    null;
  end;

  -- Deze weigering is dubbel afgeschermd: toepassen() controleert zelf, én
  -- roept taken() aan dat óók controleert. Het weghalen van de controle in
  -- toepassen() alleen maakt deze test dus NIET rood -- de binnenste vangt
  -- het op. Dat is met opzet zo (verdediging in de diepte), en het staat hier
  -- omdat een lezer anders denkt dat deze regel de buitenste controle bewijst.
  begin
    perform public.boekjaar_wijziging_toepassen(v_w);
    raise exception 'FAIL 56.9: boekjaar_wijziging_toepassen() liet een vreemde herrekenen';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.boekjaar_wijziging_negeren(v_w);
    raise exception 'FAIL 56.9: boekjaar_wijziging_negeren() liet een vreemde de melding sluiten';
  exception when insufficient_privilege then
    null;
  end;

  set local role postgres;
  raise notice 'PASS 56.9: de teammuur geldt ook voor de drie boekjaarfuncties';
end $$;

-- ============================================================
-- Sectie 57 (0053): een verplichting die op een afgesproken datum stopt.
--
-- Het scenario is een vereffening. De vennootschap blijft na de ontbinding
-- bestaan vóór haar vereffening (art. 2:76 WVV), dus alles loopt door tot de
-- sluiting -- en dan houdt het op. Hier: de sluiting valt op 31/12/2026.
--
-- De scherpe kant zit in 57.2: de aangifte over boekjaar 2026 wordt pas op
-- 30/09/2027 ingediend, negen maanden ná de einddatum, en moet er dus wél
-- staan. De grens ligt op de periode, niet op de deadline.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_klant uuid; v_ot_venb uuid; v_ot_av uuid; v_ot_neer uuid; v_co_venb uuid;
  v_n int; v_due date; v_status public.task_status;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 's57@test.local', now());
  insert into public.firms (naam) values ('S57 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S57 Beheerder', 's57@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S57 Vereffening BV', 12, 31, 'geen', true) returning id into v_klant;

  select id into v_ot_venb from public.obligation_types where code = 'aangifte_venb_pb';
  select id into v_ot_av   from public.obligation_types where code = 'algemene_vergadering';
  select id into v_ot_neer from public.obligation_types where code = 'neerlegging_jaarrekening';

  -- De sluiting van de vereffening valt op 31/12/2026.
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, geldig_tot)
    values (v_klant, v_ot_venb, true, date '2000-01-01', date '2026-12-31')
    returning id into v_co_venb;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, geldig_tot)
    values (v_klant, v_ot_av, true, date '2000-01-01', date '2026-12-31');

  perform public.generate_task_instances(36, 0);

  -- 57.1 Niets over een boekjaar na de sluiting.
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_venb
     and periode_eind > date '2026-12-31';
  if v_n <> 0 then
    raise exception 'FAIL 57.1: % aangifte(s) voor een boekjaar na de sluiting van de vereffening', v_n;
  end if;
  raise notice 'PASS 57.1: na de einddatum wordt er niets meer gemaakt';

  -- 57.2 De aangifte over het LAATSTE boekjaar staat er wél, ook al valt haar
  --      deadline ruim na de einddatum. Dit is de test die het verschil maakt
  --      tussen "grens op de periode" en "grens op de deadline".
  select due_date into v_due from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_venb
     and periode_eind = date '2026-12-31';
  if v_due is null then
    raise exception 'FAIL 57.2: de aangifte over het laatste boekjaar ontbreekt';
  end if;
  -- Geen vaste datum verwacht: er kan een campagnedatum uit legal_calendar
  -- overheen liggen, en die mag winnen. Wat deze test wél moet vastleggen is
  -- dat de deadline ná de einddatum valt -- anders bewijst ze het verschil
  -- tussen "grens op de periode" en "grens op de deadline" niet.
  if v_due <= date '2026-12-31' then
    raise exception 'FAIL 57.2: deze test bewijst niets -- de deadline (%) valt niet na de einddatum', v_due;
  end if;
  raise notice 'PASS 57.2: de aangifte over het laatste boekjaar blijft, ook al valt ze na de einddatum';

  -- 57.3 De neerlegging volgt de algemene vergadering en verdwijnt mee.
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_neer
     and periode_eind > date '2026-12-31';
  if v_n <> 0 then
    raise exception 'FAIL 57.3: % neerlegging(en) na de sluiting, terwijl de AV ophoudt', v_n;
  end if;
  raise notice 'PASS 57.3: de neerlegging houdt op zodra de algemene vergadering ophoudt';

  -- ---------------------------------------------------------
  -- 57.4 Een einddatum die er later bij komt, ruimt op wat er al staat.
  --      Zonder dit geldt de grens alleen voor nieuwe taken, en met een
  --      horizon van 36 maanden is dat bijna niets.
  -- ---------------------------------------------------------
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S57 Stopt later', 12, 31, 'geen', true) returning id into v_klant;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_klant, v_ot_venb, true, date '2000-01-01') returning id into v_co_venb;
  perform public.generate_task_instances(36, 0);

  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_venb
     and periode_eind > date '2026-12-31' and status = 'open';
  if v_n = 0 then
    raise exception 'FAIL 57.4: geen taken na 2026 om op te ruimen -- de test bewijst niets';
  end if;

  update public.client_obligations set geldig_tot = date '2026-12-31' where id = v_co_venb;
  perform public.sync_client_tasks(v_klant);

  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_venb
     and periode_eind > date '2026-12-31' and status = 'open';
  if v_n <> 0 then
    raise exception 'FAIL 57.4: % taak/taken na de einddatum blijven open staan', v_n;
  end if;

  select status into v_status from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_venb
     and periode_eind = date '2027-12-31';
  if v_status is distinct from 'geannuleerd' then
    raise exception 'FAIL 57.4: de taak over 2027 staat op % i.p.v. geannuleerd', coalesce(v_status::text, 'niets');
  end if;

  -- En wat vóór de einddatum ligt, blijft ongemoeid.
  select status into v_status from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_venb
     and periode_eind = date '2026-12-31';
  if v_status is distinct from 'open' then
    raise exception 'FAIL 57.4: de taak over het laatste boekjaar is meegesneuveld (%)', coalesce(v_status::text, 'niets');
  end if;
  raise notice 'PASS 57.4: een einddatum ruimt op wat er al stond, en laat het laatste boekjaar staan';

  -- 57.5 Zonder einddatum verandert er niets.
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S57 Loopt door', 12, 31, 'geen', true) returning id into v_klant;
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_klant, v_ot_venb, true, date '2000-01-01');
  perform public.generate_task_instances(36, 0);
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_venb
     and periode_eind > date '2026-12-31';
  if v_n = 0 then
    raise exception 'FAIL 57.5: een verplichting zonder einddatum genereert niets meer na 2026';
  end if;
  raise notice 'PASS 57.5: zonder einddatum loopt alles gewoon door';
end $$;

-- ============================================================
-- Sectie 58 (0054): in vereffening is niet hetzelfde als vereffend.
--
-- Het kantoor: "Een dossier kan in vereffening staan voor meerdere jaren,
-- maar een vereffening is gedaan." De wet zegt hetzelfde: de vennootschap
-- blijft na de ontbinding bestaan vóór haar vereffening (art. 2:76 WVV) en de
-- rechtspersoonlijkheid verdwijnt pas bij de sluiting.
--
-- 58.1 is dus even belangrijk als 58.2: een ontbinding mag NIETS veranderen.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_klant uuid; v_ot_venb uuid; v_co uuid;
  v_voor int; v_na int; v_n int; v_aantal int;
  v_status public.task_status; v_tot date; v_melding text;
begin
  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 's58@test.local', now());
  insert into public.firms (naam) values ('S58 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S58 Beheerder', 's58@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S58 Klant', 12, 31, 'geen', true) returning id into v_klant;
  select id into v_ot_venb from public.obligation_types where code = 'aangifte_venb_pb';
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_klant, v_ot_venb, true, date '2000-01-01') returning id into v_co;

  perform public.generate_task_instances(36, 0);
  select count(*) into v_voor from public.task_instances
   where client_id = v_klant and status = 'open';
  if v_voor = 0 then
    raise exception 'FAIL 58.0: geen taken om mee te beginnen';
  end if;

  -- ---------------------------------------------------------
  -- 58.1 IN VEREFFENING verandert niets aan de taken.
  --      Een vereffening kan jaren duren; intussen dient de vereffenaar
  --      gewoon elk jaar de aangifte in (art. 305, derde lid in fine WIB 92).
  -- ---------------------------------------------------------
  update public.clients set ontbonden_op = date '2026-04-30' where id = v_klant;
  perform public.sync_client_tasks(v_klant);

  select count(*) into v_na from public.task_instances
   where client_id = v_klant and status = 'open';
  if v_na <> v_voor then
    raise exception 'FAIL 58.1: een ontbinding veranderde het aantal open taken van % naar %', v_voor, v_na;
  end if;
  select geldig_tot into v_tot from public.client_obligations where id = v_co;
  if v_tot is not null then
    raise exception 'FAIL 58.1: een ontbinding zette al een einddatum (%)', v_tot;
  end if;
  raise notice 'PASS 58.1: in vereffening laat de verplichtingen ongemoeid';

  -- 58.1b En het staat in de historiek van het dossier.
  select count(*) into v_n from public.client_change_log
   where client_id = v_klant and veld = 'ontbonden_op';
  if v_n <> 1 then
    raise exception 'FAIL 58.1b: de ontbinding staat % keer in de historiek i.p.v. één keer', v_n;
  end if;
  raise notice 'PASS 58.1b: de ontbinding staat in de historiek van het dossier';

  -- ---------------------------------------------------------
  -- 58.2 VEREFFEND zet de einddatum op de verplichtingen.
  -- ---------------------------------------------------------
  v_aantal := public.klant_vereffend(v_klant, date '2027-09-30');
  if v_aantal < 1 then
    raise exception 'FAIL 58.2: geen enkele verplichting kreeg een einddatum';
  end if;
  select geldig_tot into v_tot from public.client_obligations where id = v_co;
  if v_tot is distinct from date '2027-09-30' then
    raise exception 'FAIL 58.2: de verplichting loopt tot % i.p.v. 30/09/2027', coalesce(v_tot::text, 'niets');
  end if;

  -- Niets meer over een boekjaar na de sluiting.
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and periode_eind > date '2027-09-30' and status = 'open';
  if v_n <> 0 then
    raise exception 'FAIL 58.2: % open taak/taken over een periode na de sluiting', v_n;
  end if;
  raise notice 'PASS 58.2: vereffend zet de einddatum en ruimt op wat erna kwam';

  -- ---------------------------------------------------------
  -- 58.3 Het papierwerk over het LAATSTE boekjaar blijft staan.
  --      Dit is het verschil met archiveren, dat alles wegveegt (0026): de
  --      aangifte over boekjaar 2026 wordt pas in september 2027 ingediend en
  --      moet er dus nog zijn.
  -- ---------------------------------------------------------
  select status into v_status from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_venb
     and periode_eind = date '2026-12-31';
  if v_status is distinct from 'open' then
    raise exception 'FAIL 58.3: de aangifte over het laatste boekjaar staat op % i.p.v. open', coalesce(v_status::text, 'niets');
  end if;
  raise notice 'PASS 58.3: de aangifte over het laatste boekjaar overleeft de sluiting';

  -- ---------------------------------------------------------
  -- 58.4 Sluiten kan niet zonder ontbinding: dat is altijd een typfout, en
  --      een typfout in deze datum haalt de verplichtingen onderuit.
  -- ---------------------------------------------------------
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief)
    values (v_firm, 'S58 Nooit ontbonden', 12, 31, 'geen', true) returning id into v_klant;
  --
  --      De check-constraint op de tabel vangt dit sowieso op, maar met een
  --      onleesbare boodschap. Deze test kijkt daarom naar de TEKST: de
  --      functie hoort zelf te zeggen wat er scheelt en wat je eraan doet.
  --      Zonder die eis zou ze vacuüm slagen op de constraint alleen.
  begin
    perform public.klant_vereffend(v_klant, date '2027-09-30');
    raise exception 'FAIL 58.4: een dossier liet zich sluiten zonder ooit ontbonden te zijn';
  exception when check_violation then
    get stacked diagnostics v_melding = message_text;
    if position('niet in vereffening' in v_melding) = 0 then
      raise exception 'FAIL 58.4: de weigering legt niet uit wat er scheelt (%)', v_melding;
    end if;
  end;
  raise notice 'PASS 58.4: sluiten kan niet zonder ontbinding, met een leesbare reden';

  -- 58.5 En sluiten vóór de ontbinding evenmin.
  update public.clients set ontbonden_op = date '2027-01-01' where id = v_klant;
  begin
    update public.clients set vereffend_op = date '2026-01-01' where id = v_klant;
    raise exception 'FAIL 58.5: een sluiting vóór de ontbinding werd aanvaard';
  exception when check_violation then
    null;
  end;
  raise notice 'PASS 58.5: een sluiting kan niet vóór de ontbinding vallen';
end $$;

-- ============================================================
-- Sectie 59 (0055): can_view_client() is niet meer van buitenaf op te roepen.
--
-- De functie beantwoordt "mag medewerker X dossier Y zien?" voor een
-- WILLEKEURIGE X. Zolang `authenticated` er EXECUTE op had, kon een gewone
-- medewerker daarmee uitvragen welke collega's toegang hebben tot een
-- vertrouwelijk dossier dat hij zelf niet mag zien -- en aan het verschil
-- tussen null en false zien of een dossier-id bestaat.
--
-- 59.2 is de belangrijkste: de weigering mag de interne oproepers niet
-- meenemen. Die zijn zelf security definer en moeten blijven werken, want
-- can_access_client() zit in de RLS van bijna elke tabel.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_ander uuid; v_ander_uid uuid := gen_random_uuid();
  v_klant uuid; v_taak uuid;
  v_n int;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_admin_uid, 's59a@test.local', now()),
    (v_ander_uid, 's59b@test.local', now());
  insert into public.firms (naam) values ('S59 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S59 Beheerder', 's59a@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_ander_uid, 'S59 Medewerker', 's59b@test.local', 'medewerker', false, true)
    returning id into v_ander;

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, actief, vertrouwelijk, standaard_verantwoordelijke_id)
    values (v_firm, 'S59 Vertrouwelijk', 12, 31, 'geen', true, true, v_admin)
    returning id into v_klant;

  -- ---------------------------------------------------------
  -- 59.1 Een gewone medewerker kan de functie niet meer aanroepen.
  -- ---------------------------------------------------------
  perform set_config('taskflow.test_uid', v_ander_uid::text, true);
  set local role authenticated;
  begin
    perform public.can_view_client(v_klant, v_admin);
    set local role postgres;
    raise exception 'FAIL 59.1: can_view_client() is nog van buitenaf op te roepen';
  exception when insufficient_privilege then
    null;
  end;
  set local role postgres;
  raise notice 'PASS 59.1: can_view_client() is niet meer aanroepbaar door authenticated';

  -- ---------------------------------------------------------
  -- 59.2 En de interne oproepers werken gewoon door.
  -- ---------------------------------------------------------
  -- Eerst zonder werk: het vertrouwelijke dossier hoort onzichtbaar te zijn.
  -- Zonder deze helft zou 59.2 ook slagen als de RLS iedereen binnenliet.
  perform set_config('taskflow.test_uid', v_ander_uid::text, true);
  set local role authenticated;
  select count(*) into v_n from public.clients where id = v_klant;
  set local role postgres;
  if v_n <> 0 then
    raise exception 'FAIL 59.2: het vertrouwelijke dossier was al zichtbaar zonder toegewezen werk (% rijen)', v_n;
  end if;

  insert into public.task_instances (
    client_id, title, due_date, due_date_wettelijk,
    status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring
  ) values (
    v_klant, 'S59 lopend werk', current_date + 30, current_date + 30,
    'open', v_ander, 'handmatig_adhoc', false
  ) returning id into v_taak;

  perform set_config('taskflow.test_uid', v_ander_uid::text, true);
  set local role authenticated;
  select count(*) into v_n from public.clients where id = v_klant;
  set local role postgres;
  if v_n <> 1 then
    raise exception 'FAIL 59.2: de medewerker met een toegewezen taak ziet het dossier niet meer (% rijen)', v_n;
  end if;
  raise notice 'PASS 59.2: de interne oproepers werken door -- de RLS staat overeind';

  -- ---------------------------------------------------------
  -- 59.3 Een kantoorbeheerder krijgt evenmin een uitzondering. Dit is geen
  --      rolkwestie: de functie hoort helemaal niet aan de API te hangen.
  -- ---------------------------------------------------------
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  begin
    perform public.can_view_client(v_klant, v_ander);
    set local role postgres;
    raise exception 'FAIL 59.3: een kantoorbeheerder kan can_view_client() nog aanroepen';
  exception when insufficient_privilege then
    null;
  end;
  set local role postgres;
  raise notice 'PASS 59.3: ook een kantoorbeheerder komt er niet meer bij';
end $$;

-- ============================================================
-- Sectie 60 (0056): het kantooroverzicht.
--
-- Twee dingen moeten kloppen en ze trekken aan elkaar: het overzicht moet
-- OPEN genoeg zijn (een supervisor hoort erbij te kunnen, dat was net het
-- probleem) en tegelijk DICHT genoeg (de muur mag er niet door lekken).
-- 60.3 en 60.4 bewaken die twee kanten.
-- ============================================================
do $$
declare
  v_firm uuid;
  v_admin uuid;   v_admin_uid uuid := gen_random_uuid();
  v_junior uuid;  v_junior_uid uuid := gen_random_uuid();
  v_super uuid;   v_super_uid uuid := gen_random_uuid();
  v_t_a uuid; v_t_b uuid;
  v_klant_a uuid; v_klant_b uuid; v_ot uuid; v_taak uuid;
  v_n int; v_rij record;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_admin_uid, 's60a@test.local', now()),
    (v_junior_uid, 's60b@test.local', now()),
    (v_super_uid, 's60c@test.local', now());
  insert into public.firms (naam) values ('S60 Kantoor') returning id into v_firm;
  insert into public.teams (firm_id, code, naam, vestiging) values
    (v_firm, 'S60A', 'S60 Team A', 'Aalst') returning id into v_t_a;
  insert into public.teams (firm_id, code, naam, vestiging) values
    (v_firm, 'S60B', 'S60 Team B', 'Zaventem') returning id into v_t_b;

  insert into public.employees (firm_id, auth_user_id, naam, email, rol, niveau, actief)
    values (v_firm, v_admin_uid, 'S60 Beheerder', 's60a@test.local', 'kantoorbeheerder', 'partner', true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, niveau, actief)
    values (v_firm, v_junior_uid, 'S60 Junior', 's60b@test.local', 'medewerker', 'junior', true)
    returning id into v_junior;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, niveau, actief)
    values (v_firm, v_super_uid, 'S60 Supervisor', 's60c@test.local', 'medewerker', 'supervisor', true)
    returning id into v_super;
  insert into public.employee_teams (employee_id, team_id) values
    (v_super, v_t_a), (v_junior, v_t_a);

  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id)
    values (v_firm, 'S60 Klant A', 12, 31, 'geen', true, v_t_a) returning id into v_klant_a;
  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag, btw_regime, actief, team_id)
    values (v_firm, 'S60 Klant B', 12, 31, 'geen', true, v_t_b) returning id into v_klant_b;

  select id into v_ot from public.obligation_types where code = 'jaarafsluiting';

  -- Team A: één taak te laat en zonder naam -- het gevaarlijkste geval.
  -- De provenance-trigger (0013) herschrijft een met de hand ingevoegde
  -- 'automatisch_gegenereerd' naar 'handmatig_adhoc'; dezelfde vlag als de
  -- generator zet, zet dat recht. Nodig omdat alleen een gegenereerde taak
  -- een verplichtingstype draagt, en dus meetelt in te_laat_wettelijk.
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (client_id, obligation_type_id, periode_label,
      periode_start, periode_eind, due_date, due_date_wettelijk, status,
      toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_klant_a, v_ot, '2024', date '2024-01-01', date '2024-12-31',
      current_date - 20, current_date - 20, 'open', null, 'automatisch_gegenereerd', true);
  perform set_config('taskflow.generating', 'off', true);

  -- Team A: één taak die te lang bij de klant ligt.
  --
  -- De stempel `wacht_op_klant_sinds` is eigendom van de statustrigger (0047)
  -- en wordt bij elke update overschreven met de oude waarde; er is dus geen
  -- gewone weg om er een datum van veertig dagen geleden in te zetten. Zelfde
  -- aanpak als de backfill van 0047: de trigger even uit, de stempel zetten,
  -- trigger weer aan.
  -- Een taak begint altijd op 'open' -- de insert dwingt dat af -- dus de
  -- wachtstand komt van een statuswijziging, en die zet de stempel op nu.
  insert into public.task_instances (client_id, title, due_date, due_date_wettelijk,
      toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_klant_a, 'S60 wacht lang', current_date + 30, current_date + 30,
      v_super, 'handmatig_adhoc', false)
    returning id into v_taak;
  perform set_config('taskflow.test_uid', v_super_uid::text, true);
  update public.task_instances set status = 'wacht_op_klant' where id = v_taak;
  alter table public.task_instances disable trigger trg_task_instances_enforce_transition;
  update public.task_instances
     set wacht_op_klant_sinds = now() - interval '40 days'
   where id = v_taak;
  alter table public.task_instances enable trigger trg_task_instances_enforce_transition;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  -- Team B: twee taken, waarvan één te laat. Team A hoort die NIET te zien.
  insert into public.task_instances (client_id, title, due_date, due_date_wettelijk,
      status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_klant_b, 'S60 B te laat', current_date - 5, current_date - 5,
      'open', null, 'handmatig_adhoc', false);
  insert into public.task_instances (client_id, title, due_date, due_date_wettelijk,
      status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_klant_b, 'S60 B op tijd', current_date + 10, current_date + 10,
      'open', null, 'handmatig_adhoc', false);

  -- ---------------------------------------------------------
  -- 60.1 De kantoorbeheerder ziet beide teams.
  -- ---------------------------------------------------------
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  select count(*) into v_n from public.kantooroverzicht();
  set local role postgres;
  if v_n <> 2 then
    raise exception 'FAIL 60.1: de kantoorbeheerder ziet % team(s) i.p.v. 2', v_n;
  end if;
  raise notice 'PASS 60.1: de kantoorbeheerder ziet alle teams';

  -- ---------------------------------------------------------
  -- 60.2 De getallen kloppen, en het gevaarlijkste getal staat er apart in:
  --      werk dat te laat is én dat niemand op zich heeft staan.
  -- ---------------------------------------------------------
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  select * into v_rij from public.kantooroverzicht() where team_code = 'S60A';
  set local role postgres;
  if v_rij.open_totaal <> 2 then
    raise exception 'FAIL 60.2: team A telt % open taken i.p.v. 2', v_rij.open_totaal;
  end if;
  if v_rij.te_laat <> 1 or v_rij.te_laat_wettelijk <> 1 then
    raise exception 'FAIL 60.2: team A: te_laat=% wettelijk=%, verwacht 1 en 1',
      v_rij.te_laat, v_rij.te_laat_wettelijk;
  end if;
  if v_rij.niemand_op <> 1 or v_rij.niemand_op_te_laat <> 1 then
    raise exception 'FAIL 60.2: team A: niemand_op=% waarvan te laat=%, verwacht 1 en 1',
      v_rij.niemand_op, v_rij.niemand_op_te_laat;
  end if;
  if v_rij.te_lang_bij_klant <> 1 then
    raise exception 'FAIL 60.2: team A telt % taken die te lang bij de klant liggen i.p.v. 1',
      v_rij.te_lang_bij_klant;
  end if;
  raise notice 'PASS 60.2: de vier getallen kloppen, inclusief te laat én zonder naam';

  -- ---------------------------------------------------------
  -- 60.3 OPEN GENOEG: een supervisor mag erbij. Dit was het probleem --
  --      het oude scherm stond op `kantoorbeheerder` en juist de graden die
  --      het meeste werk doen, konden er niet in.
  -- ---------------------------------------------------------
  perform set_config('taskflow.test_uid', v_super_uid::text, true);
  set local role authenticated;
  select count(*) into v_n from public.kantooroverzicht();
  set local role postgres;
  if v_n = 0 then
    raise exception 'FAIL 60.3: de supervisor krijgt niets te zien';
  end if;
  raise notice 'PASS 60.3: een supervisor kan het overzicht openen';

  -- ---------------------------------------------------------
  -- 60.4 DICHT GENOEG: en hij ziet alleen zijn eigen team. Zonder deze test
  --      zou 60.3 ook slagen als het overzicht de muur negeerde.
  -- ---------------------------------------------------------
  perform set_config('taskflow.test_uid', v_super_uid::text, true);
  set local role authenticated;
  select count(*) into v_n from public.kantooroverzicht() where team_code = 'S60B';
  set local role postgres;
  if v_n <> 0 then
    raise exception 'FAIL 60.4: de supervisor ziet het andere team in het overzicht';
  end if;
  raise notice 'PASS 60.4: het overzicht lekt niet door de teammuur';

  -- ---------------------------------------------------------
  -- 60.5 Een junior komt er niet in. Niet omdat het geheim is -- de muur
  --      staat er sowieso onder -- maar omdat het zijn scherm niet is.
  -- ---------------------------------------------------------
  perform set_config('taskflow.test_uid', v_junior_uid::text, true);
  set local role authenticated;
  begin
    perform * from public.kantooroverzicht();
    set local role postgres;
    raise exception 'FAIL 60.5: een junior kan het kantooroverzicht openen';
  exception when insufficient_privilege then
    null;
  end;
  set local role postgres;
  raise notice 'PASS 60.5: het overzicht begint bij supervisor';

  -- ---------------------------------------------------------
  -- 60.6 Het workload-overzicht volgt dezelfde grens en dezelfde muur.
  -- ---------------------------------------------------------
  perform set_config('taskflow.test_uid', v_super_uid::text, true);
  set local role authenticated;
  select count(*) into v_n from public.workload_per_medewerker();
  set local role postgres;
  if v_n = 0 then
    raise exception 'FAIL 60.6: de supervisor krijgt geen workload te zien';
  end if;

  -- Het werk van team B mag niet meegeteld worden bij wie het niet mag zien.
  perform set_config('taskflow.test_uid', v_super_uid::text, true);
  set local role authenticated;
  select coalesce(sum(open_totaal), 0) into v_n from public.workload_per_medewerker();
  set local role postgres;
  if v_n <> 1 then
    raise exception 'FAIL 60.6: de supervisor telt % taken i.p.v. 1 (alleen zijn eigen team, en daar staat één taak op naam)', v_n;
  end if;
  raise notice 'PASS 60.6: het workload-overzicht volgt dezelfde grens en dezelfde muur';
end $$;

-- ============================================================
-- Sectie 61 (0057): de horizon van 15 maanden.
--
-- Twee kanten die tegen elkaar in werken, en allebei moeten kloppen: de lijst
-- moet KORTER worden (61.2 en 61.3), maar de lopende cyclus mag niet
-- afgekapt worden (61.4). Dat laatste is de reden dat het 15 is en geen 12.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_klant uuid; v_ot_btw uuid; v_ot_venb uuid; v_ot_av uuid;
  v_n int; v_gesnoeid int; v_ver date; v_status public.task_status;
begin
  -- 61.1 De horizon staat op één plek, en die zegt 15.
  if public.horizon_maanden() <> 15 then
    raise exception 'FAIL 61.1: horizon_maanden() geeft % i.p.v. 15', public.horizon_maanden();
  end if;
  raise notice 'PASS 61.1: de horizon staat op 15 maanden';

  insert into auth.users (id, email, email_confirmed_at) values (v_admin_uid, 's61@test.local', now());
  insert into public.firms (naam) values ('S61 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S61 Beheerder', 's61@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S61 Klant', 12, 31, 'periodieke_aangever', 'kwartaal', true)
    returning id into v_klant;
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_klant, v_ot_av, true, date '2000-01-01');
  select id into v_ot_venb from public.obligation_types where code = 'aangifte_venb_pb';
  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
    values (v_klant, v_ot_venb, true, date '2000-01-01');

  -- ---------------------------------------------------------
  -- 61.2 Genereren met de nieuwe horizon maakt niets verder dan 15 maanden.
  -- ---------------------------------------------------------
  perform public.generate_task_instances(public.horizon_maanden(), 0);
  select count(*) into v_n from public.task_instances ti
   where ti.client_id = v_klant
     and ti.due_date > (current_date + interval '15 months')::date;
  if v_n <> 0 then
    raise exception 'FAIL 61.2: % taak/taken voorbij de horizon aangemaakt', v_n;
  end if;
  select count(*) into v_n from public.task_instances where client_id = v_klant;
  if v_n = 0 then
    raise exception 'FAIL 61.2: er is helemaal niets aangemaakt -- de test bewijst niets';
  end if;
  raise notice 'PASS 61.2: de generatie stopt bij de horizon';

  -- ---------------------------------------------------------
  -- 61.3 Wat er al voorbij de horizon stond, wordt gesnoeid -- en alleen wat
  --      nog open staat. Werk waar iemand mee bezig is blijft.
  -- ---------------------------------------------------------
  perform set_config('taskflow.generating', 'on', true);
  select id into v_ot_btw from public.obligation_types where code = 'btw_aangifte';
  insert into public.task_instances (client_id, obligation_type_id, periode_label,
      periode_start, periode_eind, due_date, due_date_wettelijk, status,
      toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_klant, v_ot_btw, 'S61-ver-open', date '2029-01-01', date '2029-03-31',
      current_date + 800, current_date + 800, 'open', v_admin, 'automatisch_gegenereerd', true);
  insert into public.task_instances (client_id, obligation_type_id, periode_label,
      periode_start, periode_eind, due_date, due_date_wettelijk, status,
      toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_klant, v_ot_btw, 'S61-ver-bezig', date '2029-04-01', date '2029-06-30',
      current_date + 801, current_date + 801, 'open', v_admin, 'automatisch_gegenereerd', true);
  perform set_config('taskflow.generating', 'off', true);
  update public.task_instances set status = 'in_uitvoering' where periode_label = 'S61-ver-bezig';

  v_gesnoeid := public.snoei_taken_buiten_horizon();
  if v_gesnoeid < 1 then
    raise exception 'FAIL 61.3: er is niets gesnoeid';
  end if;

  select status into v_status from public.task_instances where periode_label = 'S61-ver-open';
  if v_status is distinct from 'geannuleerd' then
    raise exception 'FAIL 61.3: de open taak voorbij de horizon staat op % i.p.v. geannuleerd',
      coalesce(v_status::text, 'niets');
  end if;
  select status into v_status from public.task_instances where periode_label = 'S61-ver-bezig';
  if v_status is distinct from 'in_uitvoering' then
    raise exception 'FAIL 61.3: werk waar iemand mee bezig is werd toch gesnoeid (%)',
      coalesce(v_status::text, 'niets');
  end if;
  raise notice 'PASS 61.3: buiten de horizon wordt gesnoeid, lopend werk blijft';

  -- ---------------------------------------------------------
  -- 61.4 En de lopende cyclus blijft staan. Dit is waarom het 15 is en geen
  --      12: de aangifte VenB over het boekjaar dat eind dit jaar sluit, valt
  --      pas bijna dertien maanden vooruit (winteruitzondering, 0033). Bij een
  --      horizon van twaalf maanden zou net die uit beeld vallen.
  -- ---------------------------------------------------------
  select max(due_date) into v_ver from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot_venb and status <> 'geannuleerd';
  if v_ver is null then
    raise exception 'FAIL 61.4: er staat geen aangifte VenB meer -- de horizon kapt de cyclus af';
  end if;
  if v_ver <= (current_date + interval '12 months')::date then
    raise exception
      'FAIL 61.4: de verste aangifte VenB valt op % en dus binnen 12 maanden; deze test bewijst niet dat 15 nodig is',
      v_ver;
  end if;
  raise notice 'PASS 61.4: de aangifte VenB van de lopende cyclus valt voorbij 12 maanden en blijft staan';
end $$;

-- ============================================================
-- Sectie 62 (0058): "niet van toepassing voor deze periode".
--
-- 62.3 is de test die ertoe doet. Een geannuleerde taak bezet haar
-- periodeslot niet -- met opzet, 0052 en 0053 steunen erop -- dus zonder de
-- controle in de motor zou de knop een knop zijn die niets doet: de volgende
-- generatieronde maakt de taak gewoon opnieuw aan.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_mw uuid; v_mw_uid uuid := gen_random_uuid();
  v_klant uuid; v_ot uuid; v_taak uuid; v_adhoc uuid;
  v_n int; v_status public.task_status; v_nvt boolean; v_reden text;
  v_afgerond timestamptz; v_melding text;
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_admin_uid, 's62a@test.local', now()), (v_mw_uid, 's62b@test.local', now());
  insert into public.firms (naam) values ('S62 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S62 Beheerder', 's62a@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_mw_uid, 'S62 Medewerker', 's62b@test.local', 'medewerker', false, true)
    returning id into v_mw;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief)
    values (v_firm, 'S62 Klant', 12, 31, 'periodieke_aangever', 'kwartaal', true)
    returning id into v_klant;
  select id into v_ot from public.obligation_types where code = 'btw_aangifte';
  perform public.generate_task_instances(public.horizon_maanden(), 0);

  select id into v_taak from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot and status = 'open'
   order by due_date limit 1;
  if v_taak is null then
    raise exception 'FAIL 62.0: geen btw-taak om mee te werken';
  end if;

  -- ---------------------------------------------------------
  -- 62.1 Zonder reden gaat het niet door. Een wettelijke taak die verdwijnt
  --      zonder waarom is precies het gat waar dit systeem tegen gebouwd is.
  -- ---------------------------------------------------------
  -- Op de TEKST van de weigering, niet alleen op de foutklasse: de
  -- check-constraint op de tabel vangt een lege reden óók op, met een
  -- onleesbare boodschap. Zonder deze eis zou de test vacuüm slagen en zou
  -- niemand merken dat de functie zelf niets meer controleert.
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  begin
    perform public.taak_niet_van_toepassing(v_taak, '  ');
    raise exception 'FAIL 62.1: een lege reden werd aanvaard';
  exception when check_violation then
    get stacked diagnostics v_melding = message_text;
    if position('waarom' in v_melding) = 0 then
      raise exception 'FAIL 62.1: de weigering legt niet uit wat er ontbreekt (%)', v_melding;
    end if;
  end;
  select status into v_status from public.task_instances where id = v_taak;
  if v_status is distinct from 'open' then
    raise exception 'FAIL 62.1: de taak werd toch afgesloten (%)', v_status;
  end if;
  raise notice 'PASS 62.1: zonder reden gebeurt er niets';

  -- ---------------------------------------------------------
  -- 62.2 Met een reden sluit de taak af -- en beweert niets over indienen.
  -- ---------------------------------------------------------
  perform public.taak_niet_van_toepassing(v_taak, 'Geen omzet dit kwartaal');
  select status, niet_van_toepassing, niet_van_toepassing_reden, afgerond_op
    into v_status, v_nvt, v_reden, v_afgerond
  from public.task_instances where id = v_taak;
  -- Geen afrondingsstempel: dit is geen ingediende aangifte, en de historiek
  -- mag dat ook niet suggereren.
  if v_afgerond is not null then
    raise exception 'FAIL 62.2: er staat een afrondingsstempel op (%)', v_afgerond;
  end if;
  if v_status is distinct from 'geannuleerd' or not v_nvt then
    raise exception 'FAIL 62.2: status=% nvt=%, verwacht geannuleerd en waar', v_status, v_nvt;
  end if;
  if v_reden is distinct from 'Geen omzet dit kwartaal' then
    raise exception 'FAIL 62.2: de reden is niet bewaard (%)', coalesce(v_reden, 'niets');
  end if;
  select count(*) into v_n from public.task_status_log
   where task_instance_id = v_taak and notitie like 'Niet van toepassing%';
  if v_n <> 1 then
    raise exception 'FAIL 62.2: de reden staat % keer in de historiek i.p.v. één keer', v_n;
  end if;
  raise notice 'PASS 62.2: de taak sluit af met de reden in de historiek';

  -- ---------------------------------------------------------
  -- 62.3 En ze komt NIET terug bij de volgende generatieronde. Dit is de kern:
  --      zonder deze controle bezet de geannuleerde rij haar slot niet en
  --      maakt de motor de taak gewoon opnieuw aan.
  -- ---------------------------------------------------------
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  perform public.generate_task_instances(public.horizon_maanden(), 0);
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot
     and periode_label = (select periode_label from public.task_instances where id = v_taak)
     and status <> 'geannuleerd';
  if v_n <> 0 then
    raise exception 'FAIL 62.3: de periode is opnieuw aangemaakt (% taak/taken)', v_n;
  end if;
  raise notice 'PASS 62.3: de generatie laat deze periode voortaan met rust';

  -- ---------------------------------------------------------
  -- 62.4 De markering is niet rechtstreeks te zetten. Anders verdwijnt een
  --      wettelijke taak voorgoed uit de generatie zonder reden en zonder
  --      spoor -- via een gewone PATCH op de tabel.
  -- ---------------------------------------------------------
  select id into v_taak from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot and status = 'open'
   order by due_date limit 1;
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  -- Mét een reden, anders weigert de check-constraint het al en bewijst de
  -- test niets over de bewaking in de trigger.
  set local role authenticated;
  update public.task_instances
     set niet_van_toepassing = true, niet_van_toepassing_reden = 'Langs de achterdeur'
   where id = v_taak;
  set local role postgres;
  select niet_van_toepassing into v_nvt from public.task_instances where id = v_taak;
  if v_nvt then
    raise exception 'FAIL 62.4: de markering was rechtstreeks te zetten';
  end if;
  raise notice 'PASS 62.4: de markering is alleen via de functie te zetten';

  -- ---------------------------------------------------------
  -- 62.5 Een losse taak zonder periode hoort hier niet: die annuleer je.
  -- ---------------------------------------------------------
  insert into public.task_instances (client_id, title, due_date, due_date_wettelijk,
      status, toegewezen_medewerker_id, bron_type, vereist_goedkeuring)
    values (v_klant, 'S62 los klusje', current_date + 10, current_date + 10,
      'open', v_mw, 'handmatig_adhoc', false)
    returning id into v_adhoc;
  perform set_config('taskflow.test_uid', v_mw_uid::text, true);
  begin
    perform public.taak_niet_van_toepassing(v_adhoc, 'Niets te doen');
    raise exception 'FAIL 62.5: een losse taak liet zich op niet-van-toepassing zetten';
  exception when check_violation then
    null;
  end;
  raise notice 'PASS 62.5: een losse taak hoort bij geen periode';

  -- ---------------------------------------------------------
  -- 62.6 Een al afgesloten taak kan niet alsnog "niet van toepassing" worden.
  --      Dat zou een ingediende aangifte achteraf wegpoetsen.
  -- ---------------------------------------------------------
  select id into v_taak from public.task_instances
   where client_id = v_klant and obligation_type_id = v_ot and status = 'geannuleerd'
   limit 1;
  begin
    perform public.taak_niet_van_toepassing(v_taak, 'Alsnog niets aan te geven');
    raise exception 'FAIL 62.6: een afgesloten taak liet zich alsnog markeren';
  exception when check_violation then
    null;
  end;
  raise notice 'PASS 62.6: wat al afgesloten is, blijft zoals het is';
end $$;

-- ============================================================
-- Sectie 63 (0059): de standaardverantwoordelijke doorzetten naar de taken
-- die er al staan.
--
-- 63.3 en 63.4 zijn de belangrijkste. Doorzetten is makkelijk; NIET doorzetten
-- waar iemand al iets beslist heeft is het echte werk. Een taak die bewust aan
-- een derde gegeven werd, en werk dat al op goedkeuring wacht, horen te
-- blijven staan waar ze staan.
-- ============================================================
do $$
declare
  v_firm uuid; v_admin uuid; v_admin_uid uuid := gen_random_uuid();
  v_oud uuid; v_oud_uid uuid := gen_random_uuid();
  v_nieuw uuid; v_nieuw_uid uuid := gen_random_uuid();
  v_derde uuid; v_derde_uid uuid := gen_random_uuid();
  v_klant uuid; v_ot uuid; v_ot_neer uuid; v_co uuid;
  v_taak uuid; v_derde_taak uuid; v_goedkeuring uuid; v_afgerond uuid;
  v_n int; v_geteld int; v_wie uuid; v_melding text; v_eerder uuid[];
begin
  insert into auth.users (id, email, email_confirmed_at) values
    (v_admin_uid, 's63a@test.local', now()), (v_oud_uid, 's63b@test.local', now()),
    (v_nieuw_uid, 's63c@test.local', now()), (v_derde_uid, 's63d@test.local', now());
  insert into public.firms (naam) values ('S63 Kantoor') returning id into v_firm;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_admin_uid, 'S63 Beheerder', 's63a@test.local', 'kantoorbeheerder', true, true)
    returning id into v_admin;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_oud_uid, 'S63 Vorige', 's63b@test.local', 'medewerker', false, true)
    returning id into v_oud;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_nieuw_uid, 'S63 Opvolger', 's63c@test.local', 'medewerker', false, true)
    returning id into v_nieuw;
  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
    values (v_firm, v_derde_uid, 'S63 Derde', 's63d@test.local', 'medewerker', false, true)
    returning id into v_derde;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  insert into public.clients (firm_id, naam, boekjaar_einde_maand, boekjaar_einde_dag,
                              btw_regime, btw_aangifte_frequentie, actief,
                              standaard_verantwoordelijke_id)
    values (v_firm, 'S63 Klant', 12, 31, 'periodieke_aangever', 'kwartaal', true, v_oud)
    returning id into v_klant;
  select id into v_ot from public.obligation_types where code = 'btw_aangifte';
  perform public.generate_task_instances(public.horizon_maanden(), 0);

  select id into v_co from public.client_obligations
   where client_id = v_klant and obligation_type_id = v_ot limit 1;
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and toegewezen_medewerker_id = v_oud;
  if v_n = 0 then
    raise exception 'FAIL 63.0: geen taken op naam van de vorige verantwoordelijke';
  end if;

  -- ---------------------------------------------------------
  -- 63.1 De verantwoordelijke van het DOSSIER wijzigt: de openstaande taken
  --      volgen mee. Dit is de melding van het kantoor.
  -- ---------------------------------------------------------
  update public.clients set standaard_verantwoordelijke_id = v_nieuw where id = v_klant;

  select count(*) into v_n from public.task_instances
   where client_id = v_klant and toegewezen_medewerker_id = v_oud
     and status in ('open', 'in_uitvoering', 'wacht_op_klant');
  if v_n <> 0 then
    raise exception 'FAIL 63.1: % openstaande taken staan nog op de vorige', v_n;
  end if;
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and toegewezen_medewerker_id = v_nieuw;
  if v_n = 0 then
    raise exception 'FAIL 63.1: geen enkele taak volgde mee';
  end if;
  raise notice 'PASS 63.1: % taken volgden de nieuwe verantwoordelijke', v_n;

  -- ---------------------------------------------------------
  -- 63.2 Het staat in de historiek van het dossier. Veertig taken die stil
  --      van naam wisselen is precies wat je later wilt kunnen terugvinden.
  -- ---------------------------------------------------------
  select count(*) into v_n from public.client_change_log
   where client_id = v_klant and veld = 'taken_volgen_verantwoordelijke';
  if v_n <> 1 then
    raise exception 'FAIL 63.2: % logregels i.p.v. één', v_n;
  end if;
  raise notice 'PASS 63.2: de verplaatsing staat in de historiek van het dossier';

  -- ---------------------------------------------------------
  -- 63.3 Een taak die iemand bewust aan een derde gaf, blijft van die derde.
  --      Anders wist een wijziging van de standaard stilzwijgend een
  --      menselijke beslissing uit.
  -- ---------------------------------------------------------
  select id into v_derde_taak from public.task_instances
   where client_id = v_klant and status = 'open' order by due_date limit 1;
  update public.task_instances set toegewezen_medewerker_id = v_derde where id = v_derde_taak;

  update public.clients set standaard_verantwoordelijke_id = v_oud where id = v_klant;

  select toegewezen_medewerker_id into v_wie from public.task_instances where id = v_derde_taak;
  if v_wie is distinct from v_derde then
    raise exception 'FAIL 63.3: de taak van de derde werd overschreven';
  end if;
  raise notice 'PASS 63.3: een bewuste toewijzing blijft staan';

  -- ---------------------------------------------------------
  -- 63.4 Werk dat op goedkeuring wacht, verhuist niet. Dat is gedaan werk;
  --      het op naam van een opvolger zetten maakt hem auteur van iets wat
  --      hij niet deed.
  -- ---------------------------------------------------------
  select id into v_goedkeuring from public.task_instances
   where client_id = v_klant and status = 'open' and toegewezen_medewerker_id = v_oud
   order by due_date offset 1 limit 1;
  perform set_config('taskflow.test_uid', v_oud_uid::text, true);
  update public.task_instances set status = 'wacht_op_goedkeuring' where id = v_goedkeuring;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);

  update public.clients set standaard_verantwoordelijke_id = v_nieuw where id = v_klant;

  select toegewezen_medewerker_id into v_wie from public.task_instances where id = v_goedkeuring;
  if v_wie is distinct from v_oud then
    raise exception 'FAIL 63.4: werk dat op goedkeuring wacht verhuisde mee';
  end if;
  raise notice 'PASS 63.4: wat op goedkeuring wacht blijft van wie het deed';

  -- ---------------------------------------------------------
  -- 63.5 Afgesloten taken blijven afgesloten en blijven op naam staan. De
  --      historiek van een dossier mag niet meeschuiven met wie het vandaag
  --      doet.
  -- ---------------------------------------------------------
  select id into v_afgerond from public.task_instances
   where client_id = v_klant and status = 'open' and toegewezen_medewerker_id = v_nieuw
   order by due_date limit 1;
  perform set_config('taskflow.test_uid', v_nieuw_uid::text, true);
  update public.task_instances set status = 'wacht_op_goedkeuring' where id = v_afgerond;
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  update public.task_instances set status = 'ingediend_afgerond' where id = v_afgerond;

  update public.clients set standaard_verantwoordelijke_id = v_derde where id = v_klant;

  select toegewezen_medewerker_id into v_wie from public.task_instances where id = v_afgerond;
  if v_wie is distinct from v_nieuw then
    raise exception 'FAIL 63.5: een afgesloten taak wisselde van naam';
  end if;
  raise notice 'PASS 63.5: de historiek schuift niet mee';

  -- ---------------------------------------------------------
  -- 63.6 De verantwoordelijke van ÉÉN verplichting gaat voor op die van het
  --      dossier -- ook hier. Zet je hem op de verplichting, dan volgen
  --      alleen de taken van díe verplichting.
  -- ---------------------------------------------------------
  update public.client_obligations
     set standaard_toegewezen_medewerker_id = v_oud where id = v_co;

  select count(*) into v_n from public.task_instances
   where client_obligation_id = v_co and toegewezen_medewerker_id = v_oud
     and status in ('open', 'in_uitvoering', 'wacht_op_klant');
  if v_n = 0 then
    raise exception 'FAIL 63.6: de verplichting kreeg haar taken niet mee';
  end if;
  select count(*) into v_n from public.client_change_log
   where client_obligation_id = v_co and veld = 'taken_volgen_verantwoordelijke';
  if v_n <> 1 then
    raise exception 'FAIL 63.6: % logregels op de verplichting i.p.v. één', v_n;
  end if;
  raise notice 'PASS 63.6: de verplichting neemt haar eigen taken mee';

  -- ---------------------------------------------------------
  -- 63.7 En als de verplichting haar eigen naam weer loslaat, valt ze terug
  --      op het dossier -- niet op niemand. Zonder die terugval zou het
  --      leegmaken van één veld veertig taken in de bak van het team gooien.
  -- ---------------------------------------------------------
  update public.client_obligations
     set standaard_toegewezen_medewerker_id = null where id = v_co;

  select count(*) into v_n from public.task_instances
   where client_obligation_id = v_co and toegewezen_medewerker_id is null;
  if v_n <> 0 then
    raise exception 'FAIL 63.7: % taken kwamen zonder naam te staan', v_n;
  end if;
  select count(*) into v_n from public.task_instances
   where client_obligation_id = v_co and toegewezen_medewerker_id = v_derde
     and status in ('open', 'in_uitvoering', 'wacht_op_klant');
  if v_n = 0 then
    raise exception 'FAIL 63.7: de taken vielen niet terug op de verantwoordelijke van het dossier';
  end if;
  raise notice 'PASS 63.7: leegmaken valt terug op het dossier, niet op niemand';

  -- ---------------------------------------------------------
  -- 63.8 De verplaatsing is niet los aan te roepen. Ze gaat langs RLS heen;
  --      buiten de triggers om zou ze de taken van een ander kantoor kunnen
  --      verzetten.
  -- ---------------------------------------------------------
  perform set_config('taskflow.test_uid', v_admin_uid::text, true);
  set local role authenticated;
  begin
    perform public.taken_volgen_verantwoordelijke(v_klant, v_co, v_derde, v_oud);
    set local role postgres;
    raise exception 'FAIL 63.8: de functie was rechtstreeks aan te roepen';
  exception when insufficient_privilege then
    set local role postgres;
    null;
  end;
  raise notice 'PASS 63.8: de verplaatsing loopt alleen via de triggers';

  -- ---------------------------------------------------------
  -- 63.9 (0060) Een taak ZONDER naam volgt mee, ook al stond de vorige
  --      standaard op iemand anders. Dit is het geval dat zich op een echt
  --      dossier voordeed: taken gegenereerd vóór er een verantwoordelijke
  --      was, dus naamloos, en daarna elke wissel voorbij zien gaan.
  --
  --      De prijs staat er bewust in: deze taak is hier BEWUST teruggelegd in
  --      de bak, en krijgt toch weer een naam. Zie de kop van 0060.
  -- ---------------------------------------------------------
  select id into v_taak from public.task_instances
   where client_obligation_id = v_co and status = 'open'
   order by due_date limit 1;
  update public.task_instances set toegewezen_medewerker_id = null where id = v_taak;

  update public.clients set standaard_verantwoordelijke_id = v_nieuw where id = v_klant;

  select toegewezen_medewerker_id into v_wie from public.task_instances where id = v_taak;
  if v_wie is distinct from v_nieuw then
    raise exception 'FAIL 63.9: een taak zonder naam bleef in de bak liggen';
  end if;
  raise notice 'PASS 63.9: taken zonder naam volgen de nieuwe verantwoordelijke';

  -- ---------------------------------------------------------
  -- 63.10 Andersom niet: wie de verantwoordelijke leegmaakt, geeft het werk
  --       terug aan het team. De bak blijft dan de bak -- en telt ook niet
  --       mee als "verplaatst". Zonder die grens beweert de historiek dat er
  --       taken van eigenaar wisselden die al lang zonder naam lagen.
  -- ---------------------------------------------------------
  select id into v_derde_taak from public.task_instances
   where client_id = v_klant and status = 'open' and toegewezen_medewerker_id = v_nieuw
   order by due_date limit 1;
  update public.task_instances set toegewezen_medewerker_id = null where id = v_derde_taak;

  -- Zoveel taken staan er écht op naam en wisselen dus echt van eigenaar.
  select count(*) into v_n from public.task_instances
   where client_id = v_klant and toegewezen_medewerker_id = v_nieuw
     and status in ('open', 'in_uitvoering', 'wacht_op_klant');
  if v_n = 0 then
    raise exception 'FAIL 63.10: geen taken op naam om mee te meten';
  end if;

  -- Het hele blok is één transactie, dus elke logregel draagt dezelfde
  -- created_at: "de nieuwste" bestaat hier niet. Onthouden wat er al stond is
  -- de enige manier om de regel van déze update terug te vinden.
  select coalesce(array_agg(id), '{}'::uuid[]) into v_eerder
  from public.client_change_log
  where client_id = v_klant and veld = 'taken_volgen_verantwoordelijke';

  update public.clients set standaard_verantwoordelijke_id = null where id = v_klant;

  select count(*) into v_geteld from public.task_instances
   where client_id = v_klant and toegewezen_medewerker_id = v_nieuw
     and status in ('open', 'in_uitvoering', 'wacht_op_klant');
  if v_geteld <> 0 then
    raise exception 'FAIL 63.10: % taken bleven op naam staan na het leegmaken', v_geteld;
  end if;

  select oude_waarde into v_melding from public.client_change_log
   where client_id = v_klant and veld = 'taken_volgen_verantwoordelijke'
     and client_obligation_id is null
     and not (id = any(v_eerder));
  if split_part(v_melding, ' ', 1) <> v_n::text then
    raise exception 'FAIL 63.10: de historiek meldt "%" terwijl er % taken van naam wisselden',
      v_melding, v_n;
  end if;
  raise notice 'PASS 63.10: leegmaken geeft het werk terug aan het team, en telt alleen wat echt wisselde';

  -- ---------------------------------------------------------
  -- 63.11 (0061) Een taak die aan GEEN verplichting hangt volgt ook mee.
  --       Het levende voorbeeld is de neerlegging van de jaarrekening: die
  --       hangt aan de algemene vergadering, niet aan een eigen verplichting,
  --       en draagt dus geen client_obligation_id. Ze viel buiten elke lus en
  --       bleef als enige taak van het dossier naamloos achter -- met een
  --       deadline waar een boete aan hangt.
  -- ---------------------------------------------------------
  -- Dezelfde vorm als de echte: een gegenereerde taak mét verplichtingstype
  -- maar ZONDER client_obligation_id, want ze hangt aan haar voorloper.
  select id into v_ot_neer from public.obligation_types where code = 'neerlegging_jaarrekening';
  perform set_config('taskflow.generating', 'on', true);
  insert into public.task_instances (
    client_id, obligation_type_id, client_obligation_id, periode_label,
    due_date, due_date_wettelijk, status, toegewezen_medewerker_id,
    bron_type, vereist_goedkeuring
  ) values (
    v_klant, v_ot_neer, null, 'S63-neerlegging',
    current_date + 200, current_date + 200, 'open', null,
    'automatisch_gegenereerd', true
  ) returning id into v_taak;
  perform set_config('taskflow.generating', 'off', true);

  update public.clients set standaard_verantwoordelijke_id = v_nieuw where id = v_klant;

  select toegewezen_medewerker_id into v_wie from public.task_instances where id = v_taak;
  if v_wie is distinct from v_nieuw then
    raise exception 'FAIL 63.11: een taak zonder verplichting bleef achter';
  end if;
  raise notice 'PASS 63.11: ook de taken zonder verplichting volgen mee';
end $$;

select '=== ALL RECURRENCE ENGINE TESTS PASSED ===' as result;
