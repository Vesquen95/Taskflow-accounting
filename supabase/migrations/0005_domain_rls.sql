-- Taskflow v1 — Row Level Security for the domain schema (docs/PLAN.md
-- §5). Firm-scoped everywhere; clients/client_obligations/task_instances/
-- task_status_log are additionally gated through can_access_client() for
-- confidential clients (§2.11).
--
-- Design notes:
-- * `firms` and `employees` have no INSERT policy for `authenticated` —
--   the only way to create a firm or an employee row is through the
--   SECURITY DEFINER onboarding RPCs in 0007 (create_firm_and_admin,
--   invite_employee, claim_invite), which apply their own authorization
--   checks before writing. This is a hard boundary: a compromised/buggy
--   client can not self-elevate into an arbitrary firm.
-- * `task_status_log` has no INSERT/UPDATE policy for `authenticated` —
--   every row is written by a SECURITY DEFINER trigger function (0004),
--   which runs as the table owner and therefore bypasses RLS. This keeps
--   the audit trail tamper-proof from the client's perspective.
-- * `legal_calendar`/`public_holidays` are global reference tables (see
--   0003 notes) — any authenticated employee of any firm may read them,
--   only a kantoorbeheerder may write.

alter table public.firms enable row level security;
alter table public.employees enable row level security;
alter table public.clients enable row level security;
alter table public.obligation_types enable row level security;
alter table public.client_obligations enable row level security;
alter table public.task_instances enable row level security;
alter table public.task_status_log enable row level security;
alter table public.legal_calendar enable row level security;
alter table public.public_holidays enable row level security;

-- ============================================================
-- firms
-- ============================================================
drop policy if exists "firms_select" on public.firms;
create policy "firms_select" on public.firms
  for select using (id = public.current_employee_firm_id());

-- ============================================================
-- employees
-- ============================================================
drop policy if exists "employees_select" on public.employees;
create policy "employees_select" on public.employees
  for select using (firm_id = public.current_employee_firm_id());

drop policy if exists "employees_update" on public.employees;
create policy "employees_update" on public.employees
  for update using (
    firm_id = public.current_employee_firm_id() and public.is_kantoorbeheerder()
  ) with check (
    firm_id = public.current_employee_firm_id()
  );

-- ============================================================
-- clients
-- ============================================================
drop policy if exists "clients_select" on public.clients;
create policy "clients_select" on public.clients
  for select using (public.can_access_client(id));

drop policy if exists "clients_insert" on public.clients;
create policy "clients_insert" on public.clients
  for insert with check (firm_id = public.current_employee_firm_id());

drop policy if exists "clients_update" on public.clients;
create policy "clients_update" on public.clients
  for update using (public.can_access_client(id))
  with check (firm_id = public.current_employee_firm_id());

-- ============================================================
-- obligation_types — fixed catalogue, readable by any authenticated
-- employee, never writable from the client (no insert/update policy).
-- ============================================================
drop policy if exists "obligation_types_select" on public.obligation_types;
create policy "obligation_types_select" on public.obligation_types
  for select using (public.current_employee_id() is not null);

-- ============================================================
-- client_obligations
-- ============================================================
drop policy if exists "client_obligations_select" on public.client_obligations;
create policy "client_obligations_select" on public.client_obligations
  for select using (public.can_access_client(client_id));

drop policy if exists "client_obligations_insert" on public.client_obligations;
create policy "client_obligations_insert" on public.client_obligations
  for insert with check (public.can_access_client(client_id));

drop policy if exists "client_obligations_update" on public.client_obligations;
create policy "client_obligations_update" on public.client_obligations
  for update using (public.can_access_client(client_id))
  with check (public.can_access_client(client_id));

-- ============================================================
-- task_instances
-- ============================================================
drop policy if exists "task_instances_select" on public.task_instances;
create policy "task_instances_select" on public.task_instances
  for select using (public.can_access_client(client_id));

drop policy if exists "task_instances_insert" on public.task_instances;
create policy "task_instances_insert" on public.task_instances
  for insert with check (public.can_access_client(client_id));

drop policy if exists "task_instances_update" on public.task_instances;
create policy "task_instances_update" on public.task_instances
  for update using (public.can_access_client(client_id))
  with check (public.can_access_client(client_id));

-- ============================================================
-- task_status_log — read-only for the app (writes are trigger-only)
-- ============================================================
drop policy if exists "task_status_log_select" on public.task_status_log;
create policy "task_status_log_select" on public.task_status_log
  for select using (
    exists (
      select 1 from public.task_instances ti
      where ti.id = task_status_log.task_instance_id
        and public.can_access_client(ti.client_id)
    )
  );

-- ============================================================
-- legal_calendar (global, kantoorbeheerder-only writes)
-- ============================================================
drop policy if exists "legal_calendar_select" on public.legal_calendar;
create policy "legal_calendar_select" on public.legal_calendar
  for select using (public.current_employee_id() is not null);

drop policy if exists "legal_calendar_insert" on public.legal_calendar;
create policy "legal_calendar_insert" on public.legal_calendar
  for insert with check (
    public.is_kantoorbeheerder()
    and aangemaakt_door = public.current_employee_id()
    and gewijzigd_door = public.current_employee_id()
  );

-- Deliberately no UPDATE policy: corrections are new is_override rows
-- (see 0003 unique index note) so the override history stays visible.

-- ============================================================
-- public_holidays (global, kantoorbeheerder-only writes)
-- ============================================================
drop policy if exists "public_holidays_select" on public.public_holidays;
create policy "public_holidays_select" on public.public_holidays
  for select using (public.current_employee_id() is not null);

drop policy if exists "public_holidays_insert" on public.public_holidays;
create policy "public_holidays_insert" on public.public_holidays
  for insert with check (
    public.is_kantoorbeheerder()
    and aangemaakt_door = public.current_employee_id()
    and gewijzigd_door = public.current_employee_id()
  );

drop policy if exists "public_holidays_update" on public.public_holidays;
create policy "public_holidays_update" on public.public_holidays
  for update using (public.is_kantoorbeheerder())
  with check (public.is_kantoorbeheerder() and gewijzigd_door = public.current_employee_id());
