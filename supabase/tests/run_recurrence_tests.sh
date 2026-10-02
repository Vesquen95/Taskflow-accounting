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

# Opruimen, ook als een test faalt. Zonder deze trap bleef de testdatabank
# na een rode run staan -- en hield ze de rollen anon en authenticated vast,
# zodat een volgende proef die ze wilde weghalen stil mislukte en vacuüm
# groen werd (02/10/2026).
trap 'dropdb --if-exists "$DB_NAME" >/dev/null 2>&1 || true' EXIT

echo "==> Dropping/creating database '$DB_NAME'"
dropdb --if-exists "$DB_NAME"
createdb "$DB_NAME"

echo "==> Bootstrapping local auth stub"
"${PSQL[@]}" -d "$DB_NAME" -f "$SCRIPT_DIR/00_local_auth_stub.sql"

# Elke migratie, in volgorde. Tot 02/10/2026 stond hier een uitgeschreven lijst
# 0001 0002 ... die bij elke nieuwe migratie met de hand verlengd moest
# worden. Wie dat vergat, liet de harnas stilzwijgend tegen het oude schema
# draaien. De glob sorteert lexicografisch, en de vier cijfers maken dat
# gelijk aan de nummervolgorde.
for file in "$MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.sql; do
  echo "==> Applying $(basename "$file")"
  "${PSQL[@]}" -d "$DB_NAME" -f "$file"
done

echo "==> Running recurrence engine tests"
"${PSQL[@]}" -d "$DB_NAME" -f "$SCRIPT_DIR/recurrence_engine_test.sql"

echo "==> Cleaning up ('$DB_NAME')"
dropdb --if-exists "$DB_NAME"

echo "==> Done."
