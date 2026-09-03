-- ============================================================
-- 0038 — Teams
--
-- RSM werkt in teams, niet in één pot. Aalst (AAL), drie teams in Zaventem
-- (ZAV1, ZAV2, ZAV3), Antwerpen (ANT) en Gosselies (GOS). Een dossier hoort
-- bij een team, en een team hoort niet in andermans dossiers te kijken.
--
-- Deze migratie zet alleen de structuur neer. De afscherming zelf komt in
-- 0039, en de teambak (een taak zonder naam) in 0040. Zo blijft elke stap
-- apart terug te draaien en apart te testen.
--
-- Drie keuzes die hier vastliggen:
--
--  1. Het team staat op de KLANT, niet op de taak. Een taak erft haar team van
--     het dossier. Twee plaatsen onderhouden betekent dat ze uit elkaar gaan
--     lopen, en dan is de vraag "van wie is dit werk" niet meer eenduidig te
--     beantwoorden.
--
--  2. Een medewerker kan bij MEER DAN ÉÉN team horen (employee_teams). Een
--     vennoot volgt twee teams op, iemand springt bij tijdens de piek. Met een
--     enkele kolom moet je zo iemand verhuizen, en dan verliest hij zijn eigen
--     team uit het oog.
--
--  3. clients.team_id mag LEEG zijn, en een dossier zonder team blijft voor
--     iedereen zichtbaar (zie 0039). Anders zou het invoeren van teams honderd
--     dossiers in één klap onzichtbaar maken -- precies het soort stille
--     verdwijning dat dit systeem nergens mag hebben. Het scherm zegt dan dat
--     er nog een team gekozen moet worden.
--
-- De vestiging staat als tekstveld op het team en niet als eigen tabel. Er
-- zijn vier vestigingen en zes teams; een tweede niveau bouwen voor het
-- groeperen van drie Zaventem-teams is meer machinerie dan vraag.
-- ============================================================

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  code text not null,
  naam text not null,
  vestiging text not null,
  actief boolean not null default true,
  created_at timestamptz not null default now(),
  constraint teams_code_check check (char_length(trim(code)) between 1 and 10),
  constraint teams_naam_check check (char_length(trim(naam)) between 1 and 100),
  constraint teams_vestiging_check check (char_length(trim(vestiging)) between 1 and 100)
);

-- De code is wat het kantoor uitspreekt ("die klant zit bij ZAV2"), dus die
-- moet uniek zijn binnen het kantoor en niet per ongeluk twee keer bestaan.
create unique index if not exists teams_firm_code_uniek
  on public.teams (firm_id, upper(trim(code)));

create index if not exists teams_firm_idx on public.teams (firm_id) where actief;

comment on table public.teams is
  'De teams van het kantoor. Een dossier hoort bij één team; wie niet in dat team zit, ziet het dossier niet (0039).';
comment on column public.teams.vestiging is
  'De plaats waar het team zit (Aalst, Zaventem, ...). Alleen om te groeperen in overzichten: de afscherming loopt per team, niet per vestiging.';

-- ------------------------------------------------------------
-- Lidmaatschap: veel-op-veel
-- ------------------------------------------------------------
create table if not exists public.employee_teams (
  employee_id uuid not null references public.employees(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (employee_id, team_id)
);

create index if not exists employee_teams_team_idx on public.employee_teams (team_id);

comment on table public.employee_teams is
  'Wie zit in welk team. Meervoudig lidmaatschap is toegestaan: een vennoot volgt twee teams op, en wie bijspringt hoeft niet verhuisd te worden.';

-- Een lidmaatschap over kantoorgrenzen heen is geen vergissing die je stil
-- laat staan: dan zou iemand van buiten het kantoor in de dossiers kunnen.
create or replace function public.enforce_employee_team_firm()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_emp_firm uuid;
  v_team_firm uuid;
begin
  select firm_id into v_emp_firm from public.employees where id = new.employee_id;
  select firm_id into v_team_firm from public.teams where id = new.team_id;
  if v_emp_firm is null or v_team_firm is null or v_emp_firm <> v_team_firm then
    raise exception 'Deze medewerker en dit team horen niet bij hetzelfde kantoor'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_employee_team_firm() from public, anon, authenticated;

drop trigger if exists trg_employee_teams_firm on public.employee_teams;
create trigger trg_employee_teams_firm
  before insert or update on public.employee_teams
  for each row execute function public.enforce_employee_team_firm();

-- ------------------------------------------------------------
-- Het dossier krijgt een team
-- ------------------------------------------------------------
alter table public.clients
  add column if not exists team_id uuid references public.teams(id) on delete restrict;

create index if not exists clients_team_idx on public.clients (team_id);

comment on column public.clients.team_id is
  'Het team dat dit dossier draait. Leeg = nog niet ingedeeld; zo''n dossier blijft voor iedereen van het kantoor zichtbaar, zodat het niet stil verdwijnt maar opvalt.';

-- Het team van een dossier hoort bij hetzelfde kantoor als het dossier zelf.
create or replace function public.enforce_client_team_firm()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_team_firm uuid;
begin
  if new.team_id is null then
    return new;
  end if;
  select firm_id into v_team_firm from public.teams where id = new.team_id;
  if v_team_firm is null or v_team_firm <> new.firm_id then
    raise exception 'Dit team hoort niet bij het kantoor van deze klant'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_client_team_firm() from public, anon, authenticated;

drop trigger if exists trg_clients_team_firm on public.clients;
create trigger trg_clients_team_firm
  before insert or update of team_id, firm_id on public.clients
  for each row execute function public.enforce_client_team_firm();

-- ------------------------------------------------------------
-- Rechten
--
-- Iedereen van het kantoor mag de teamlijst en de lidmaatschappen zien: je
-- moet kunnen weten bij wie een dossier hoort, ook als je er zelf niet in mag.
-- Wijzigen is voorbehouden aan een kantoorbeheerder -- lid worden van een team
-- is toegang krijgen, en dat is geen beslissing die je zelf neemt.
-- ------------------------------------------------------------
alter table public.teams enable row level security;
alter table public.employee_teams enable row level security;

drop policy if exists teams_select on public.teams;
create policy teams_select on public.teams
  for select using (firm_id = public.current_employee_firm_id());

drop policy if exists teams_insert on public.teams;
create policy teams_insert on public.teams
  for insert with check (
    firm_id = public.current_employee_firm_id() and public.is_kantoorbeheerder()
  );

drop policy if exists teams_update on public.teams;
create policy teams_update on public.teams
  for update
  using (firm_id = public.current_employee_firm_id() and public.is_kantoorbeheerder())
  with check (firm_id = public.current_employee_firm_id());

drop policy if exists employee_teams_select on public.employee_teams;
create policy employee_teams_select on public.employee_teams
  for select using (
    exists (
      select 1 from public.employees e
      where e.id = employee_teams.employee_id
        and e.firm_id = public.current_employee_firm_id()
    )
  );

drop policy if exists employee_teams_insert on public.employee_teams;
create policy employee_teams_insert on public.employee_teams
  for insert with check (
    public.is_kantoorbeheerder()
    and exists (
      select 1 from public.employees e
      where e.id = employee_teams.employee_id
        and e.firm_id = public.current_employee_firm_id()
    )
  );

drop policy if exists employee_teams_delete on public.employee_teams;
create policy employee_teams_delete on public.employee_teams
  for delete using (
    public.is_kantoorbeheerder()
    and exists (
      select 1 from public.employees e
      where e.id = employee_teams.employee_id
        and e.firm_id = public.current_employee_firm_id()
    )
  );

grant select on public.teams to authenticated;
grant insert, update on public.teams to authenticated;
grant select, insert, delete on public.employee_teams to authenticated;

-- ------------------------------------------------------------
-- De teams van RSM InterFiduciaire
--
-- Per kantoor aangemaakt en niet hardgecodeerd op één firm_id: er is vandaag
-- één kantoor, maar een migratie die op een uuid staat te wachten is een
-- migratie die op de volgende omgeving stilletjes niets doet.
-- ------------------------------------------------------------
do $seed$
declare
  r_firm record;
begin
  for r_firm in select id from public.firms loop
    insert into public.teams (firm_id, code, naam, vestiging)
    values
      (r_firm.id, 'AAL',  'Aalst',      'Aalst'),
      (r_firm.id, 'ZAV1', 'Zaventem 1', 'Zaventem'),
      (r_firm.id, 'ZAV2', 'Zaventem 2', 'Zaventem'),
      (r_firm.id, 'ZAV3', 'Zaventem 3', 'Zaventem'),
      (r_firm.id, 'ANT',  'Antwerpen',  'Antwerpen'),
      (r_firm.id, 'GOS',  'Gosselies',  'Gosselies')
    on conflict do nothing;
  end loop;
end $seed$;
