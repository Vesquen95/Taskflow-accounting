-- Taskflow v1 — helper functions + business-rule triggers (docs/PLAN.md §3
-- and §2.11). All "current employee" helpers are SECURITY DEFINER so they
-- can be safely called from within RLS policies on public.employees itself
-- without recursive-RLS issues (they run as the function owner, which is
-- not subject to RLS on the underlying table).

-- ============================================================
-- 1. Identity helpers
-- ============================================================
create or replace function public.current_employee_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select id from public.employees where auth_user_id = auth.uid() limit 1;
$$;

create or replace function public.current_employee_firm_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select firm_id from public.employees where auth_user_id = auth.uid() limit 1;
$$;

create or replace function public.is_kantoorbeheerder()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select rol = 'kantoorbeheerder' and actief from public.employees where auth_user_id = auth.uid() limit 1),
    false
  );
$$;

create or replace function public.mag_goedkeuren()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select mag_goedkeuren and actief from public.employees where auth_user_id = auth.uid() limit 1),
    false
  );
$$;

grant execute on function public.current_employee_id() to authenticated;
grant execute on function public.current_employee_firm_id() to authenticated;
grant execute on function public.is_kantoorbeheerder() to authenticated;
grant execute on function public.mag_goedkeuren() to authenticated;

-- ============================================================
-- 2. can_view_client() — verbatim from docs/PLAN.md §2.11.
-- ============================================================
create or replace function public.can_view_client(p_client_id uuid, p_employee_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select
    not c.vertrouwelijk
    or e.rol = 'kantoorbeheerder'
    or exists (
      select 1 from task_instances ti
      where ti.client_id = p_client_id
        and ti.toegewezen_medewerker_id = p_employee_id
        and ti.status <> 'geannuleerd'
    )
  from clients c, employees e
  where c.id = p_client_id and e.id = p_employee_id;
$$;

grant execute on function public.can_view_client(uuid, uuid) to authenticated;

-- can_access_client(): the predicate actually used in RLS policies. It
-- adds the firm-scoping check that can_view_client() itself intentionally
-- leaves out (can_view_client() only answers "is this client
-- confidential and, if so, may this specific employee see it" — it does
-- NOT check that the client and the employee belong to the same firm, so
-- using it alone in RLS would let an employee of firm A view a
-- non-confidential client of firm B).
create or replace function public.can_access_client(p_client_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from public.clients c
    where c.id = p_client_id
      and c.firm_id = public.current_employee_firm_id()
      and public.can_view_client(c.id, public.current_employee_id())
  );
$$;

grant execute on function public.can_access_client(uuid) to authenticated;

-- ============================================================
-- 3. Due-date pipeline building block (§3.1): iteratively push a date
--    forward over weekends and public holidays.
-- ============================================================
create or replace function public.next_business_day(p_date date)
returns date
language plpgsql stable security definer set search_path = public
as $$
declare
  d date := p_date;
  v_guard int := 0;
begin
  loop
    v_guard := v_guard + 1;
    if v_guard > 60 then
      -- Safety valve: 60 consecutive non-business days is impossible in
      -- practice and signals a data problem, not a real deadline shift.
      raise exception 'next_business_day: kon geen werkdag vinden binnen 60 dagen na %', p_date;
    end if;
    if extract(isodow from d) < 6 and not exists (
      select 1 from public.public_holidays h where h.datum = d
    ) then
      return d;
    end if;
    d := d + 1;
  end loop;
end;
$$;

grant execute on function public.next_business_day(date) to authenticated;

-- ============================================================
-- 4. employees: normalise email, enforce offboarding block (§3 point 6)
-- ============================================================
create or replace function public.normalize_employee_email()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;

drop trigger if exists trg_employees_normalize_email on public.employees;
create trigger trg_employees_normalize_email
  before insert or update of email on public.employees
  for each row
  execute function public.normalize_employee_email();

create or replace function public.block_offboarding_with_open_tasks()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_open_count int;
begin
  if old.actief = true and new.actief = false then
    select count(*) into v_open_count
    from public.task_instances ti
    where ti.toegewezen_medewerker_id = old.id
      and ti.status not in ('ingediend_afgerond', 'geannuleerd');

    if v_open_count > 0 then
      raise exception
        'Kan medewerker % niet deactiveren: nog % open taak/taken toegewezen. Herverdeel deze taken eerst.',
        old.naam, v_open_count
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_employees_block_offboarding on public.employees;
create trigger trg_employees_block_offboarding
  before update of actief on public.employees
  for each row
  execute function public.block_offboarding_with_open_tasks();

-- ============================================================
-- 5. clients: btw_regime -> client_obligations sync (§2.3 trigger note)
--    Never deletes client_obligations rows. Keeps the effectief-gedateerd
--    pattern: to "reactivate" an obligation that was previously closed, a
--    fresh row is opened rather than resurrecting the old one, so each
--    row's `parameters` stay tied to the period they were actually valid.
-- ============================================================
create or replace function public.sync_btw_obligations()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_ot_aangifte uuid;
  v_ot_listing uuid;
  v_needs_aangifte boolean;
  v_needs_listing boolean;
begin
  select id into v_ot_aangifte from public.obligation_types where code = 'btw_aangifte';
  select id into v_ot_listing from public.obligation_types where code = 'btw_klantenlisting';

  v_needs_aangifte := (new.btw_regime = 'periodieke_aangever');
  v_needs_listing := (new.btw_regime <> 'geen');

  -- BTW-aangifte
  if v_needs_aangifte then
    if not exists (
      select 1 from public.client_obligations
      where client_id = new.id and obligation_type_id = v_ot_aangifte and actief and geldig_tot is null
    ) then
      insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf, parameters)
      values (new.id, v_ot_aangifte, true, current_date, jsonb_build_object('frequentie', new.btw_aangifte_frequentie));
    else
      update public.client_obligations
      set parameters = jsonb_set(parameters, '{frequentie}', to_jsonb(new.btw_aangifte_frequentie::text))
      where client_id = new.id and obligation_type_id = v_ot_aangifte and actief and geldig_tot is null;
    end if;
  else
    update public.client_obligations
    set actief = false, geldig_tot = current_date
    where client_id = new.id and obligation_type_id = v_ot_aangifte and actief and geldig_tot is null;
  end if;

  -- BTW-klantenlisting
  if v_needs_listing then
    if not exists (
      select 1 from public.client_obligations
      where client_id = new.id and obligation_type_id = v_ot_listing and actief and geldig_tot is null
    ) then
      insert into public.client_obligations (client_id, obligation_type_id, actief, geldig_vanaf)
      values (new.id, v_ot_listing, true, current_date);
    end if;
  else
    update public.client_obligations
    set actief = false, geldig_tot = current_date
    where client_id = new.id and obligation_type_id = v_ot_listing and actief and geldig_tot is null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_clients_sync_btw_obligations on public.clients;
create trigger trg_clients_sync_btw_obligations
  after insert or update of btw_regime, btw_aangifte_frequentie on public.clients
  for each row
  execute function public.sync_btw_obligations();

-- ============================================================
-- 6. client_obligations: mid-year parameter change -> review_vereist on
--    open/future task_instances (§3 point 3).
-- ============================================================
create or replace function public.flag_tasks_for_review()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid := public.current_employee_id();
  v_reason text;
begin
  -- Only relevant when parameters actually changed, or the row was just
  -- closed off in favour of a successor row (effectief-gedateerd change).
  if new.parameters is distinct from old.parameters then
    v_reason := 'Parameters van de onderliggende verplichting werden gewijzigd op ' || to_char(now(), 'DD/MM/YYYY');
  elsif old.geldig_tot is null and new.geldig_tot is not null then
    v_reason := 'Deze verplichting werd afgesloten/vervangen op ' || to_char(new.geldig_tot, 'DD/MM/YYYY');
  else
    return new;
  end if;

  update public.task_instances
  set review_vereist = true, review_reden = v_reason
  where client_obligation_id = old.id
    and status in ('open', 'in_uitvoering', 'wacht_op_klant');

  return new;
end;
$$;

drop trigger if exists trg_client_obligations_flag_review on public.client_obligations;
create trigger trg_client_obligations_flag_review
  after update on public.client_obligations
  for each row
  execute function public.flag_tasks_for_review();

-- ============================================================
-- 7. task_instances: statusflow enforcement + audit logging (§2.7, §5,
--    §7 four-eyes decision) + toewijzing/review logging (§2.8).
-- ============================================================
create or replace function public.enforce_task_instance_transition()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_actor uuid;
  v_can_approve boolean;
begin
  if new.status is distinct from old.status then
    v_actor := public.current_employee_id();
    if v_actor is null then
      raise exception 'Statuswijziging vereist een ingelogde, gekoppelde medewerker';
    end if;

    if old.status in ('ingediend_afgerond', 'geannuleerd') then
      raise exception 'Taak met status % is afgesloten en kan niet meer wijzigen', old.status;
    end if;

    if new.status = 'wacht_op_goedkeuring' and not old.vereist_goedkeuring then
      raise exception 'Deze taak vereist geen goedkeuring (categorie is geen "wettelijk")';
    end if;

    -- Only an employee with mag_goedkeuren may move a task OUT of
    -- wacht_op_goedkeuring, whether approving or rejecting (§5). Four-eyes
    -- is allowed (not blocked here) — the UI shows a non-blocking warning
    -- when goedgekeurd_door = toegewezen_medewerker_id (§7 point 3).
    if old.status = 'wacht_op_goedkeuring' and new.status in ('ingediend_afgerond', 'in_uitvoering') then
      select mag_goedkeuren and actief into v_can_approve from public.employees where id = v_actor;
      if not coalesce(v_can_approve, false) then
        raise exception 'Alleen medewerkers met goedkeuringsrecht kunnen deze taak goedkeuren of terugsturen';
      end if;

      if new.status = 'ingediend_afgerond' then
        new.goedgekeurd_door := v_actor;
        new.goedgekeurd_op := now();
        insert into public.task_status_log (task_instance_id, event_type, actor_employee_id, trigger_bron)
          values (new.id, 'goedkeuring_gegeven', v_actor, 'medewerker_actie');
      else
        new.goedgekeurd_door := null;
        new.goedgekeurd_op := null;
        insert into public.task_status_log (task_instance_id, event_type, actor_employee_id, trigger_bron)
          values (new.id, 'goedkeuring_geweigerd', v_actor, 'medewerker_actie');
      end if;
    end if;

    if new.status = 'ingediend_afgerond' and new.afgerond_op is null then
      new.afgerond_op := now();
    end if;

    insert into public.task_status_log (task_instance_id, event_type, oud_status, nieuw_status, actor_employee_id, trigger_bron)
      values (new.id, 'status_wijziging', old.status, new.status, v_actor, 'medewerker_actie');
  end if;

  if new.toegewezen_medewerker_id is distinct from old.toegewezen_medewerker_id then
    v_actor := coalesce(v_actor, public.current_employee_id());
    if v_actor is null then
      raise exception 'Herverdeling vereist een ingelogde, gekoppelde medewerker';
    end if;
    insert into public.task_status_log (task_instance_id, event_type, actor_employee_id, trigger_bron, notitie)
      values (
        new.id, 'toewijzing_gewijzigd', v_actor, 'medewerker_actie',
        format('Herverdeeld van medewerker %s naar %s', old.toegewezen_medewerker_id, new.toegewezen_medewerker_id)
      );
  end if;

  if new.review_vereist is distinct from old.review_vereist then
    v_actor := coalesce(v_actor, public.current_employee_id());
    if v_actor is not null then
      insert into public.task_status_log (task_instance_id, event_type, actor_employee_id, trigger_bron, notitie)
        values (
          new.id,
          (case when new.review_vereist then 'review_gemarkeerd' else 'review_afgehandeld' end)::public.log_event_type,
          v_actor, 'medewerker_actie', new.review_reden
        );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_task_instances_enforce_transition on public.task_instances;
create trigger trg_task_instances_enforce_transition
  before update on public.task_instances
  for each row
  execute function public.enforce_task_instance_transition();

-- ============================================================
-- 8. Kalendercorrectie (§3 point 4): a new is_override legal_calendar row,
--    or any newly-added public holiday, recalculates due_date on affected
--    OPEN task_instances (never ones already in progress/approval/done).
-- ============================================================
create or replace function public.recalc_due_dates_on_legal_calendar_override()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_new_due date;
begin
  if not new.is_override then
    return new;
  end if;

  for r in
    select ti.id, ti.due_date_wettelijk
    from public.task_instances ti
    where ti.obligation_type_id = new.obligation_type_id
      and ti.status = 'open'
      and (
        extract(year from ti.periode_eind) = new.jaar
        or extract(year from ti.due_date_wettelijk) = new.jaar
      )
      and (new.scope is null or ti.periode_label ilike '%' || new.scope || '%')
  loop
    v_new_due := public.next_business_day(new.deadline_datum);
    if v_new_due is distinct from (select due_date from public.task_instances where id = r.id) then
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
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_legal_calendar_recalc on public.legal_calendar;
create trigger trg_legal_calendar_recalc
  after insert on public.legal_calendar
  for each row
  execute function public.recalc_due_dates_on_legal_calendar_override();

create or replace function public.recalc_due_dates_on_new_holiday()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_new_due date;
begin
  for r in
    select ti.id, ti.due_date, ti.due_date_wettelijk
    from public.task_instances ti
    where ti.status = 'open'
  loop
    v_new_due := public.next_business_day(r.due_date_wettelijk);
    if v_new_due is distinct from r.due_date then
      update public.task_instances set due_date = v_new_due where id = r.id;

      insert into public.task_status_log (
        task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
      ) values (
        r.id, 'due_date_herberekend', r.due_date, v_new_due,
        new.aangemaakt_door, 'kalender_herberekening',
        'Herberekend n.a.v. nieuwe feestdag ' || to_char(new.datum, 'DD/MM/YYYY')
      );
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_public_holidays_recalc on public.public_holidays;
create trigger trg_public_holidays_recalc
  after insert on public.public_holidays
  for each row
  execute function public.recalc_due_dates_on_new_holiday();

-- ============================================================
-- 9. AV -> neerlegging (§3 point 5): when the algemene_vergadering task
--    is completed, recalculate the linked neerlegging_jaarrekening
--    instance's due date from the actual completion date.
-- ============================================================
create or replace function public.recalc_neerlegging_after_av()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_ot_av uuid;
  v_actor uuid;
  v_raw date;
  v_due date;
  r record;
begin
  select id into v_ot_av from public.obligation_types where code = 'algemene_vergadering';

  if new.status = 'ingediend_afgerond' and old.status <> 'ingediend_afgerond' and new.obligation_type_id = v_ot_av then
    v_actor := coalesce(public.current_employee_id(), new.toegewezen_medewerker_id);
    v_raw := coalesce(new.afgerond_op::date, current_date) + 30;
    v_due := public.next_business_day(v_raw);

    for r in
      select id, due_date_wettelijk from public.task_instances where voorloper_taak_id = new.id
    loop
      update public.task_instances
      set due_date_wettelijk = v_raw, due_date = v_due, voorlopige_datum = false
      where id = r.id;

      insert into public.task_status_log (
        task_instance_id, event_type, oude_due_date, nieuwe_due_date, actor_employee_id, trigger_bron, notitie
      ) values (
        r.id, 'due_date_herberekend', r.due_date_wettelijk, v_raw, v_actor, 'av_opvolging_automatisch',
        'Definitieve datum berekend op basis van effectieve afronding van de AV (+30 dagen)'
      );
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_task_instances_av_neerlegging on public.task_instances;
create trigger trg_task_instances_av_neerlegging
  after update on public.task_instances
  for each row
  execute function public.recalc_neerlegging_after_av();
