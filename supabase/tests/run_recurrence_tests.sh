#!/usr/bin/env bash
# Runs the recurrence-engine SQL regression tests
# (recurrence_engine_test.sql) against a throwaway local Postgres database.
#
# Requirements: a local Postgres server reachable via `psql`/`createdb`/
# `dropdb` (Postgres 13+ for built-in gen_random_uuid()). Nothing here talks
# to Supabase — it's a plain local database used only to validate the SQL
# logic in isolation from RLS/auth.
#
# Usage:
#   ./run_recurrence_tests.sh
#   TASKFLOW_TEST_DB=my_db PGUSER=postgres ./run_recurrence_tests.sh
#
# On a system where only the `postgres` OS user can connect by default
# (e.g. a fresh apt install), run it as:
#   sudo -u postgres ./run_recurrence_tests.sh

set -euo pipefail

DB_NAME="${TASKFLOW_TEST_DB:-taskflow_recurrence_test}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$(cd "$SCRIPT_DIR/../migrations" && pwd)"
PSQL=(psql -v ON_ERROR_STOP=1 -X)

echo "==> Dropping/creating database '$DB_NAME'"
dropdb --if-exists "$DB_NAME"
createdb "$DB_NAME"

echo "==> Bootstrapping local auth stub"
"${PSQL[@]}" -d "$DB_NAME" -f "$SCRIPT_DIR/00_local_auth_stub.sql"

for prefix in 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0013 0014 0015 0016 0017 0018 0019 0020 0021 0022 0023 0024; do
  file="$(ls "$MIGRATIONS_DIR/${prefix}"_*.sql)"
  echo "==> Applying $(basename "$file")"
  "${PSQL[@]}" -d "$DB_NAME" -f "$file"
done

echo "==> Running recurrence engine tests"
"${PSQL[@]}" -d "$DB_NAME" -f "$SCRIPT_DIR/recurrence_engine_test.sql"

echo "==> Cleaning up ('$DB_NAME')"
dropdb --if-exists "$DB_NAME"

echo "==> Done."
