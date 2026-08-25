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
