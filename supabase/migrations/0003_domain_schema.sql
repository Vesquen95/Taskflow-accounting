-- Taskflow v1 — domain schema for a Belgian accounting firm compliance
-- tool. Replaces the generic boards/columns/labels/tasks data model as the
-- application's schema (see docs/PLAN.md §0 and §2). 0001/0002 are left in
-- place as history; their tables are simply no longer used by the app.
--
-- This migration creates the tables only (+ the fixed obligation_types
-- catalogue seed data, per §2.5). Functions, triggers and RLS policies are
-- in 0004/0005; the recurrence engine is in 0006; onboarding RPCs +
-- demo-data seeding are in 0007.

-- ============================================================
-- 0. Retire the old generic-kanban auto-provisioning trigger
--    (docs/PLAN.md §0: "vervangen door kantoor/medewerker-onboarding").
--    The boards/columns/labels/tasks tables themselves are left alone.
-- ============================================================
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- ============================================================
-- 1. Enum types
-- ============================================================
do $$ begin
  create type public.employee_rol as enum ('medewerker', 'kantoorbeheerder');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.btw_regime as enum ('geen', 'periodieke_aangever', 'vrijgesteld_kleine_onderneming');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.btw_frequentie as enum ('maand', 'kwartaal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.obligation_categorie as enum ('wettelijk', 'service');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.deadline_mechanisme as enum (
    'formule', 'boekjaar_relatief', 'jaarlijkse_kalender', 'afgeleid_van_gebeurtenis'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.task_status as enum (
    'open', 'in_uitvoering', 'wacht_op_klant', 'wacht_op_goedkeuring',
    'ingediend_afgerond', 'geannuleerd'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.taak_bron as enum ('automatisch_gegenereerd', 'handmatig_adhoc');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.log_event_type as enum (
    'status_wijziging', 'due_date_herberekend', 'toewijzing_gewijzigd',
    'review_gemarkeerd', 'review_afgehandeld', 'goedkeuring_gegeven', 'goedkeuring_geweigerd'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.log_trigger_bron as enum (
    'medewerker_actie', 'kalender_herberekening', 'av_opvolging_automatisch'
  );
exception when duplicate_object then null; end $$;

-- ============================================================
-- 2. firms
-- ============================================================
create table if not exists public.firms (
  id uuid primary key default gen_random_uuid(),
  naam text not null check (char_length(trim(naam)) > 0 and char_length(naam) <= 200),
  created_at timestamptz not null default now()
);

-- ============================================================
-- 3. employees
--    NOTE (deviation from docs/PLAN.md §2.2, documented pragmatic choice):
--    `auth_user_id` is nullable and `email` was added. This is what makes
--    invite-only colleague onboarding (§6/§7) possible without a service
--    role: a kantoorbeheerder can create a pending employee row (email set,
--    auth_user_id null) before the colleague ever signs up; when that
--    person registers, claim_invite() (0007) links auth_user_id by
--    matching their verified auth email. See §6 decision note in the
--    developer summary.
-- ============================================================
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  naam text not null check (char_length(trim(naam)) > 0 and char_length(naam) <= 200),
  email text not null check (char_length(email) > 0 and char_length(email) <= 320),
  rol public.employee_rol not null default 'medewerker',
  mag_goedkeuren boolean not null default false,
  actief boolean not null default true,
  created_at timestamptz not null default now(),
  unique (auth_user_id),
  unique (firm_id, email)
);

create index if not exists idx_employees_firm_id on public.employees(firm_id);

-- ============================================================
-- 4. clients
-- ============================================================
create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  naam text not null check (char_length(trim(naam)) > 0 and char_length(naam) <= 200),
  ondernemingsnummer text check (ondernemingsnummer is null or char_length(ondernemingsnummer) <= 20),
  rechtsvorm text check (rechtsvorm is null or char_length(rechtsvorm) <= 100),
  boekjaar_einde_maand smallint not null default 12 check (boekjaar_einde_maand between 1 and 12),
  boekjaar_einde_dag smallint not null default 31 check (boekjaar_einde_dag between 1 and 31),
  btw_regime public.btw_regime not null default 'geen',
  btw_aangifte_frequentie public.btw_frequentie,
  mandataris boolean not null default false,
  vertrouwelijk boolean not null default false,
  standaard_verantwoordelijke_id uuid references public.employees(id),
  actief boolean not null default true,
  created_at timestamptz not null default now(),
  constraint clients_btw_freq_only_when_periodiek check (
    (btw_regime = 'periodieke_aangever' and btw_aangifte_frequentie is not null)
    or (btw_regime <> 'periodieke_aangever' and btw_aangifte_frequentie is null)
  ),
  constraint clients_confidential_needs_owner check (
    not vertrouwelijk or standaard_verantwoordelijke_id is not null
  ),
  unique (firm_id, ondernemingsnummer)
);

create index if not exists idx_clients_firm_id on public.clients(firm_id);
create index if not exists idx_clients_standaard_verantwoordelijke on public.clients(standaard_verantwoordelijke_id);

-- ============================================================
-- 5. obligation_types (fixed catalogue — seeded below, no UI to create
--    more of these in v1, see docs/PLAN.md §2.4/§2.5)
-- ============================================================
create table if not exists public.obligation_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (char_length(code) <= 50),
  naam text not null check (char_length(naam) <= 200),
  categorie public.obligation_categorie not null,
  deadline_mechanisme public.deadline_mechanisme not null,
  standaard_periodiciteit text
);

insert into public.obligation_types (code, naam, categorie, deadline_mechanisme, standaard_periodiciteit)
values
  ('btw_aangifte', 'BTW-aangifte', 'wettelijk', 'formule', 'maand_of_kwartaal'),
  ('va_venb', 'Voorafbetaling VenB (VA1-VA4)', 'wettelijk', 'boekjaar_relatief', 'kwartaal'),
  ('jaarafsluiting', 'Jaarafsluiting', 'wettelijk', 'boekjaar_relatief', 'jaarlijks'),
  ('algemene_vergadering', 'Algemene vergadering', 'wettelijk', 'boekjaar_relatief', 'jaarlijks'),
  ('neerlegging_jaarrekening', 'Neerlegging jaarrekening (NBB)', 'wettelijk', 'afgeleid_van_gebeurtenis', 'jaarlijks'),
  ('aangifte_venb_pb', 'Aangifte VenB / PB', 'wettelijk', 'jaarlijkse_kalender', 'jaarlijks'),
  ('rapportering', 'Periodieke rapportering naar klant', 'service', 'formule', 'kwartaal'),
  ('btw_klantenlisting', 'BTW-klantenlisting', 'wettelijk', 'formule', 'jaarlijks')
on conflict (code) do nothing;

-- ============================================================
-- 6. client_obligations (effectief-gedateerd, zie §2.6)
-- ============================================================
create table if not exists public.client_obligations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  obligation_type_id uuid not null references public.obligation_types(id),
  actief boolean not null default true,
  geldig_vanaf date not null default current_date,
  geldig_tot date,
  parameters jsonb not null default '{}'::jsonb,
  standaard_toegewezen_medewerker_id uuid references public.employees(id),
  created_at timestamptz not null default now(),
  check (geldig_tot is null or geldig_tot >= geldig_vanaf)
);

create index if not exists idx_client_obligations_client_id on public.client_obligations(client_id);
create index if not exists idx_client_obligations_type_id on public.client_obligations(obligation_type_id);
-- One active row per (client, obligation_type) at a time — enforces the
-- effectief-gedateerd pattern (close the old row before opening a new one).
create unique index if not exists idx_client_obligations_one_active
  on public.client_obligations(client_id, obligation_type_id)
  where actief and geldig_tot is null;

-- ============================================================
-- 7. task_instances (zie §2.7)
-- ============================================================
create table if not exists public.task_instances (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  obligation_type_id uuid references public.obligation_types(id),
  client_obligation_id uuid references public.client_obligations(id),
  periode_label text check (periode_label is null or char_length(periode_label) <= 50),
  periode_start date,
  periode_eind date,
  due_date date not null,
  due_date_wettelijk date not null,
  due_date_verschoven boolean generated always as (due_date <> due_date_wettelijk) stored,
  status public.task_status not null default 'open',
  toegewezen_medewerker_id uuid not null references public.employees(id),
  voorloper_taak_id uuid references public.task_instances(id),
  bron_type public.taak_bron not null,
  voorlopige_datum boolean not null default false,
  vereist_goedkeuring boolean not null default false,
  goedgekeurd_door uuid references public.employees(id),
  goedgekeurd_op timestamptz,
  review_vereist boolean not null default false,
  review_reden text check (review_reden is null or char_length(review_reden) <= 500),
  title text check (title is null or char_length(title) <= 300),
  description text check (description is null or char_length(description) <= 5000),
  afgerond_op timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint task_instances_adhoc_shape check (
    (
      bron_type = 'handmatig_adhoc'
      and obligation_type_id is null
      and client_obligation_id is null
      and title is not null
      and char_length(trim(title)) > 0
      and not vereist_goedkeuring
    )
    or (
      bron_type = 'automatisch_gegenereerd'
      and obligation_type_id is not null
    )
  )
);

-- Idempotency for the recurrence engine: one instance per
-- (client, obligation_type, periode_label) among generated instances.
create unique index if not exists idx_task_instances_unique_period
  on public.task_instances(client_id, obligation_type_id, periode_label)
  where bron_type = 'automatisch_gegenereerd';

-- Supports can_view_client() (§2.11).
create index if not exists idx_task_instances_client_assignee
  on public.task_instances(client_id, toegewezen_medewerker_id)
  where status <> 'geannuleerd';

create index if not exists idx_task_instances_assignee_status
  on public.task_instances(toegewezen_medewerker_id, status);
create index if not exists idx_task_instances_due_date
  on public.task_instances(due_date)
  where status not in ('ingediend_afgerond', 'geannuleerd');
create index if not exists idx_task_instances_client_obligation
  on public.task_instances(client_obligation_id);

drop trigger if exists trg_task_instances_set_updated_at on public.task_instances;
create trigger trg_task_instances_set_updated_at
  before update on public.task_instances
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- 8. task_status_log (§2.8) — general event log, append-only from the
--    app's point of view (writes happen only via SECURITY DEFINER trigger
--    functions, see 0004; no direct insert/update RLS policy is granted).
-- ============================================================
create table if not exists public.task_status_log (
  id uuid primary key default gen_random_uuid(),
  task_instance_id uuid not null references public.task_instances(id) on delete cascade,
  event_type public.log_event_type not null,
  oud_status public.task_status,
  nieuw_status public.task_status,
  oude_due_date date,
  nieuwe_due_date date,
  actor_employee_id uuid not null references public.employees(id),
  trigger_bron public.log_trigger_bron not null,
  notitie text check (notitie is null or char_length(notitie) <= 1000),
  created_at timestamptz not null default now()
);

create index if not exists idx_task_status_log_task_id on public.task_status_log(task_instance_id, created_at);

-- ============================================================
-- 9. legal_calendar (§2.9) — deliberately NOT firm-scoped: Belgian
--    statutory deadlines are national reference data, not competitive
--    client data, and every firm using this instance benefits from a
--    shared, jointly-maintained calendar. See RLS notes in 0005.
-- ============================================================
create table if not exists public.legal_calendar (
  id uuid primary key default gen_random_uuid(),
  obligation_type_id uuid not null references public.obligation_types(id),
  jaar int not null check (jaar between 2000 and 2100),
  scope text check (scope is null or char_length(scope) <= 100),
  deadline_datum date not null,
  is_override boolean not null default false,
  bron text check (bron is null or char_length(bron) <= 300),
  publicatiedatum date,
  aangemaakt_door uuid not null references public.employees(id),
  gewijzigd_door uuid not null references public.employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one "base" (non-override) entry per (obligation_type, jaar, scope);
-- corrections are added as new is_override=true rows so history stays
-- visible (§4.7 "zichtbare historie van overrides"), never overwritten.
create unique index if not exists idx_legal_calendar_base_unique
  on public.legal_calendar(obligation_type_id, jaar, coalesce(scope, '*'))
  where not is_override;

create index if not exists idx_legal_calendar_lookup
  on public.legal_calendar(obligation_type_id, jaar);

drop trigger if exists trg_legal_calendar_set_updated_at on public.legal_calendar;
create trigger trg_legal_calendar_set_updated_at
  before update on public.legal_calendar
  for each row
  execute function public.set_updated_at();

-- ============================================================
-- 10. public_holidays (§2.10) — also global/shared, see 9. above.
-- ============================================================
create table if not exists public.public_holidays (
  id uuid primary key default gen_random_uuid(),
  jaar int not null check (jaar between 2000 and 2100),
  datum date not null unique,
  omschrijving text not null check (char_length(omschrijving) <= 200),
  aangemaakt_door uuid not null references public.employees(id),
  gewijzigd_door uuid not null references public.employees(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_public_holidays_jaar on public.public_holidays(jaar);

drop trigger if exists trg_public_holidays_set_updated_at on public.public_holidays;
create trigger trg_public_holidays_set_updated_at
  before update on public.public_holidays
  for each row
  execute function public.set_updated_at();
