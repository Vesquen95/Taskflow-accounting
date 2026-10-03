-- Local-only stub of the slice of Supabase's `auth` schema that Taskflow's
-- migrations/functions depend on (`auth.users`, `auth.uid()`). This file is
-- NEVER applied to an actual Supabase project — Supabase already provides
-- the real `auth` schema there. It exists solely so
-- recurrence_engine_test.sql can run against a throwaway, plain local
-- Postgres instance via run_recurrence_tests.sh.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  email_confirmed_at timestamptz
);

-- Mimics Supabase's auth.uid(): in production it reads the current
-- request's JWT `sub` claim; here it reads a session-local setting that the
-- test script sets explicitly via
-- select set_config('taskflow.test_uid', '<uuid>', false);
create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select nullif(current_setting('taskflow.test_uid', true), '')::uuid
$$;

-- ------------------------------------------------------------
-- De tabelrechten die Supabase zelf al gezet heeft
--
-- Supabase geeft `anon` en `authenticated` standaard rechten op alles in
-- schema public; RLS doet daar het echte werk. Lokaal bestaat die
-- standaardinstelling niet, en dan weigert Postgres een rolgewisselde test al
-- op een ontbrekende GRANT -- vóór er ook maar één policy of trigger aan bod
-- komt. Beide weigeringen dragen dezelfde SQLSTATE (42501), dus een test die
-- `insufficient_privilege` opvangt, ziet het verschil niet.
--
-- Gevonden op 04/09/2026: 77 plaatsen in dit testbestand wisselen van rol, en
-- geen enkele daarvan raakte de policy die ze beweerde te testen. Alleen
-- `teams` en `employee_teams` hadden rechten, omdat migratie 0038 ze
-- toevallig expliciet zet.
--
-- Via ALTER DEFAULT PRIVILEGES, want de tabellen bestaan hier nog niet: de
-- migraties draaien hierna, en krijgen de rechten dan vanzelf mee.
-- ------------------------------------------------------------
-- De rollen zelf. Supabase heeft ze al; een kale Postgres niet, en dan valt
-- de eerste regel hieronder om met "role anon does not exist". Rollen gelden
-- voor de hele cluster, niet per databank, dus ze kunnen er van een vorige
-- run nog staan -- vandaar de controle.
--
-- Gevonden op 02/10/2026: in een vers container faalde de harnas hier
-- meteen. In het vorige container waren de rollen ooit met de hand
-- aangemaakt, en dat was nergens vastgelegd -- de harnas draaide dus alleen
-- op één machine.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  -- 0067: de Edge Function praat met de rol service_role.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $roles$;

grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;
