-- Taskflow v1 — onboarding RPCs + demo-data seeding (docs/PLAN.md §6/§7).
--
-- Onboarding decision (documented per §6's request to pick pragmatically):
-- self-serve first-user-becomes-kantoorbeheerder, invite-only for
-- colleagues after that — exactly the option the plan calls "simplest to
-- build":
--   * create_firm_and_admin(): the FIRST user for a brand-new firm calls
--     this once; it creates the firm + their own employees row with
--     rol='kantoorbeheerder', and (only for the very first firm on the
--     whole instance) seeds the shared public-holiday calendar, plus a
--     handful of clearly-labelled demo clients for that firm.
--   * invite_employee(): a kantoorbeheerder pre-creates a colleague's
--     employees row (auth_user_id still null) by email — this is the
--     "invite".
--   * claim_invite(): when that colleague actually signs up and logs in,
--     this links their new auth.users row to the pending employees row by
--     matching their verified auth email.
-- None of this needs Supabase's admin/service-role API (which a plain
-- anon-key client cannot safely call), so it works entirely within RLS +
-- SECURITY DEFINER RPCs.

-- ============================================================
-- Internal helper: seed a starter Belgian public-holiday calendar.
-- Only ever runs once (see call site below), for the first firm created
-- on this instance. `public_holidays`/`legal_calendar` need a real
-- employees row as aangemaakt_door/gewijzigd_door (NOT NULL FK), which
-- cannot exist at migration-apply time — hence seeding here instead of in
-- 0003. This is a *starting point*, not a hardcoded rule: the
-- kantoorbeheerder is expected to review/extend it yearly via the
-- Wettelijke-kalenderbeheer screen (§3 point 7, §4.7).
-- ============================================================
create or replace function public.seed_default_public_holidays(p_actor uuid)
returns void
language sql
security definer set search_path = public
as $$
  insert into public.public_holidays (jaar, datum, omschrijving, aangemaakt_door, gewijzigd_door)
  values
    (2025, '2025-01-01', 'Nieuwjaar', p_actor, p_actor),
    (2025, '2025-04-21', 'Paasmaandag', p_actor, p_actor),
    (2025, '2025-05-01', 'Dag van de Arbeid', p_actor, p_actor),
    (2025, '2025-05-29', 'O.-L.-H. Hemelvaart', p_actor, p_actor),
    (2025, '2025-06-09', 'Pinkstermaandag', p_actor, p_actor),
    (2025, '2025-07-21', 'Nationale feestdag', p_actor, p_actor),
    (2025, '2025-08-15', 'O.-L.-V. Hemelvaart', p_actor, p_actor),
    (2025, '2025-11-01', 'Allerheiligen', p_actor, p_actor),
    (2025, '2025-11-11', 'Wapenstilstand', p_actor, p_actor),
    (2025, '2025-12-25', 'Kerstmis', p_actor, p_actor),
    (2026, '2026-01-01', 'Nieuwjaar', p_actor, p_actor),
    (2026, '2026-04-06', 'Paasmaandag', p_actor, p_actor),
    (2026, '2026-05-01', 'Dag van de Arbeid', p_actor, p_actor),
    (2026, '2026-05-14', 'O.-L.-H. Hemelvaart', p_actor, p_actor),
    (2026, '2026-05-25', 'Pinkstermaandag', p_actor, p_actor),
    (2026, '2026-07-21', 'Nationale feestdag', p_actor, p_actor),
    (2026, '2026-08-15', 'O.-L.-V. Hemelvaart', p_actor, p_actor),
    (2026, '2026-11-01', 'Allerheiligen', p_actor, p_actor),
    (2026, '2026-11-11', 'Wapenstilstand', p_actor, p_actor),
    (2026, '2026-12-25', 'Kerstmis', p_actor, p_actor),
    (2027, '2027-01-01', 'Nieuwjaar', p_actor, p_actor),
    (2027, '2027-03-29', 'Paasmaandag', p_actor, p_actor),
    (2027, '2027-05-01', 'Dag van de Arbeid', p_actor, p_actor),
    (2027, '2027-05-06', 'O.-L.-H. Hemelvaart', p_actor, p_actor),
    (2027, '2027-05-17', 'Pinkstermaandag', p_actor, p_actor),
    (2027, '2027-07-21', 'Nationale feestdag', p_actor, p_actor),
    (2027, '2027-08-15', 'O.-L.-V. Hemelvaart', p_actor, p_actor),
    (2027, '2027-11-01', 'Allerheiligen', p_actor, p_actor),
    (2027, '2027-11-11', 'Wapenstilstand', p_actor, p_actor),
    (2027, '2027-12-25', 'Kerstmis', p_actor, p_actor)
  on conflict (datum) do nothing;
$$;

-- ============================================================
-- Internal helper: a handful of clearly-labelled demo clients per new
-- firm, covering different btw_regime/boekjaar-einde combinations, so the
-- UI is immediately explorable with realistic-looking data (per the
-- developer-agent brief). All demo rows are prefixed "[DEMO]" and use
-- obviously fake ondernemingsnummers so a kantoorbeheerder can find and
-- remove them (deactivate via Klantenlijst) before onboarding real
-- clients.
-- ============================================================
create or replace function public.seed_demo_data_for_firm(p_firm_id uuid, p_actor uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_client_a uuid; -- BV, kwartaalaangever, boekjaar = kalenderjaar
  v_client_b uuid; -- NV, maandaangever, boekjaar eindigt 30/06
  v_client_c uuid; -- vertrouwelijke eenmanszaak, vrijgesteld kleine onderneming
  v_client_d uuid; -- VZW, geen btw-regime, enkel service-rapportering
  v_ot_jaarafsluiting uuid;
  v_ot_av uuid;
  v_ot_rapportering uuid;
  v_ot_va uuid;
begin
  select id into v_ot_jaarafsluiting from public.obligation_types where code = 'jaarafsluiting';
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';
  select id into v_ot_rapportering from public.obligation_types where code = 'rapportering';
  select id into v_ot_va from public.obligation_types where code = 'va_venb';

  insert into public.clients (
    firm_id, naam, ondernemingsnummer, rechtsvorm, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, btw_aangifte_frequentie, mandataris, vertrouwelijk, standaard_verantwoordelijke_id, actief
  ) values (
    p_firm_id, '[DEMO] Bakkerij Verhaegen BV', 'BE0000.000.001', 'BV', 12, 31,
    'periodieke_aangever', 'kwartaal', true, false, p_actor, true
  ) returning id into v_client_a;

  insert into public.clients (
    firm_id, naam, ondernemingsnummer, rechtsvorm, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, btw_aangifte_frequentie, mandataris, vertrouwelijk, standaard_verantwoordelijke_id, actief
  ) values (
    p_firm_id, '[DEMO] Industriebouw Peeters NV', 'BE0000.000.002', 'NV', 6, 30,
    'periodieke_aangever', 'maand', true, false, p_actor, true
  ) returning id into v_client_b;

  insert into public.clients (
    firm_id, naam, ondernemingsnummer, rechtsvorm, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, btw_aangifte_frequentie, mandataris, vertrouwelijk, standaard_verantwoordelijke_id, actief
  ) values (
    p_firm_id, '[DEMO] Consult De Smet (vertrouwelijk)', 'BE0000.000.003', 'Eenmanszaak', 12, 31,
    'vrijgesteld_kleine_onderneming', null, true, true, p_actor, true
  ) returning id into v_client_c;

  insert into public.clients (
    firm_id, naam, ondernemingsnummer, rechtsvorm, boekjaar_einde_maand, boekjaar_einde_dag,
    btw_regime, btw_aangifte_frequentie, mandataris, vertrouwelijk, standaard_verantwoordelijke_id, actief
  ) values (
    p_firm_id, '[DEMO] Buurtsportvereniging VZW', 'BE0000.000.004', 'VZW', 12, 31,
    'geen', null, false, false, null, true
  ) returning id into v_client_d;

  -- btw_aangifte / btw_klantenlisting client_obligations for A/B/C are
  -- created automatically by trg_clients_sync_btw_obligations above.

  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id)
  values
    (v_client_a, v_ot_jaarafsluiting, true, current_date, p_actor),
    (v_client_a, v_ot_av, true, current_date, p_actor),
    (v_client_a, v_ot_va, true, current_date, p_actor),
    (v_client_b, v_ot_jaarafsluiting, true, current_date, p_actor),
    (v_client_b, v_ot_av, true, current_date, p_actor),
    (v_client_b, v_ot_va, true, current_date, p_actor),
    (v_client_c, v_ot_jaarafsluiting, true, current_date, p_actor);

  insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, standaard_toegewezen_medewerker_id, parameters)
  values (
    v_client_d, v_ot_rapportering, true, current_date, p_actor,
    jsonb_build_object('frequentie', 'kwartaal', 'termijn_dagen', 10)
  );

  -- Populate the demo firm's Werklijst/Klantdossier immediately so the UI
  -- has realistic data to show right after onboarding.
  perform public.generate_task_instances(3, 6);
end;
$$;

revoke execute on function public.seed_default_public_holidays(uuid) from public, anon, authenticated;
revoke execute on function public.seed_demo_data_for_firm(uuid, uuid) from public, anon, authenticated;

-- ============================================================
-- create_firm_and_admin(): self-serve firm creation (§6).
-- ============================================================
create or replace function public.create_firm_and_admin(p_firm_naam text, p_medewerker_naam text)
returns table(employee_id uuid, firm_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
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

  select email into v_email from auth.users where id = v_uid;
  if v_email is null then
    raise exception 'Kon geen e-mailadres vinden voor deze gebruiker';
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

grant execute on function public.create_firm_and_admin(text, text) to authenticated;

-- ============================================================
-- invite_employee(): kantoorbeheerder invites a colleague by email (§6).
-- ============================================================
create or replace function public.invite_employee(
  p_naam text,
  p_email text,
  p_rol public.employee_rol default 'medewerker',
  p_mag_goedkeuren boolean default false
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_firm_id uuid := public.current_employee_firm_id();
  v_id uuid;
begin
  if v_firm_id is null or not public.is_kantoorbeheerder() then
    raise exception 'Alleen een kantoorbeheerder kan collega''s uitnodigen';
  end if;
  if p_naam is null or char_length(trim(p_naam)) = 0 then
    raise exception 'Naam is verplicht';
  end if;
  if p_email is null or char_length(trim(p_email)) = 0 then
    raise exception 'E-mailadres is verplicht';
  end if;
  if exists (select 1 from public.employees where firm_id = v_firm_id and lower(email) = lower(trim(p_email))) then
    raise exception 'Er bestaat al een medewerker met dit e-mailadres in dit kantoor';
  end if;

  insert into public.employees (firm_id, auth_user_id, naam, email, rol, mag_goedkeuren, actief)
  values (v_firm_id, null, trim(p_naam), lower(trim(p_email)), p_rol, p_mag_goedkeuren, true)
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.invite_employee(text, text, public.employee_rol, boolean) to authenticated;

-- ============================================================
-- claim_invite(): a newly-registered user links themselves to a pending
-- employees row that a kantoorbeheerder created for their email (§6).
-- ============================================================
create or replace function public.claim_invite()
returns table(employee_id uuid, firm_id uuid)
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_id uuid;
  v_firm uuid;
begin
  if v_uid is null then
    raise exception 'Niet ingelogd';
  end if;
  if exists (select 1 from public.employees where auth_user_id = v_uid) then
    raise exception 'Deze gebruiker is al gekoppeld aan een medewerkersprofiel';
  end if;

  select email into v_email from auth.users where id = v_uid;
  if v_email is null then
    raise exception 'Kon geen e-mailadres vinden voor deze gebruiker';
  end if;

  update public.employees e
  set auth_user_id = v_uid
  where lower(e.email) = lower(v_email) and e.auth_user_id is null
  returning e.id, e.firm_id into v_id, v_firm;

  if v_id is null then
    raise exception 'Geen openstaande uitnodiging gevonden voor dit e-mailadres';
  end if;

  return query select v_id, v_firm;
end;
$$;

grant execute on function public.claim_invite() to authenticated;

-- ============================================================
-- Defense in depth: trigger functions and internal helpers should never
-- be callable directly by app roles, only invoked automatically by
-- Postgres in their trigger/definer context.
-- ============================================================
revoke execute on function public.enforce_task_instance_transition() from public, anon, authenticated;
revoke execute on function public.recalc_due_dates_on_legal_calendar_override() from public, anon, authenticated;
revoke execute on function public.recalc_due_dates_on_new_holiday() from public, anon, authenticated;
revoke execute on function public.recalc_neerlegging_after_av() from public, anon, authenticated;
revoke execute on function public.sync_btw_obligations() from public, anon, authenticated;
revoke execute on function public.flag_tasks_for_review() from public, anon, authenticated;
revoke execute on function public.block_offboarding_with_open_tasks() from public, anon, authenticated;
revoke execute on function public.normalize_employee_email() from public, anon, authenticated;
revoke execute on function public.upsert_generated_task(
  uuid, uuid, uuid, text, date, date, date, uuid, public.obligation_categorie, boolean, uuid
) from public, anon, authenticated;
