#!/usr/bin/env bash
# Draait de SQL-harnas op een reeks datums in de toekomst, met een verschoven klok.
#
# Waarom dit bestaat: op 02/10/2026 bleek de harnas op bijna elke datum in de
# komende jaren om te vallen -- niet omdat er iets stuk was, maar omdat tests
# vaste jaartallen bevatten die uit het generatievenster schoven. Een harnas die
# om de verkeerde reden rood staat, verbergt de keer dat ze om de goede reden
# rood staat. En dezelfde tijdreis vond drie echte fouten in de motor (0063,
# 0064, 0065) die op de echte datum van vandaag onzichtbaar waren.
#
# Draai dit na elke wijziging aan de motor of aan de tests:
#
#   sudo -u postgres bash supabase/tests/tijdreis.sh                 # standaardreeks
#   sudo -u postgres bash supabase/tests/tijdreis.sh 2028-06-15 ...  # eigen datums
#
# Vereisten: de Postgres-binaries (initdb, pg_ctl) en libfaketime
# (`apt-get install faketime`). Het script start een EIGEN, tijdelijke cluster
# op een aparte poort; de gewone databankserver blijft onaangeroerd.
#
# Uitvoer per datum: hoeveel tests slaagden, hoeveel bewust overgeslagen werden
# (SKIP: een test die een FOD-kalender van een vast jaar vastpint, zodra dat
# jaar buiten het inhaalvenster valt), en welke faalden. Elke FAIL is een fout:
# in de motor of in een test. Geen enkele hoort er te staan.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
FAKETIME_LIB="${FAKETIME_LIB:-$(ls /usr/lib/*/faketime/libfaketime.so.1 2>/dev/null | head -1)}"
PORT="${TIJDREIS_PORT:-5499}"

if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "Geen Postgres-binaries gevonden (zet PGBIN)."; exit 2
fi
if [ -z "$FAKETIME_LIB" ]; then
  echo "libfaketime ontbreekt: apt-get install faketime"; exit 2
fi

# Standaard: een reeks datums vanaf vandaag tot vijf jaar vooruit, met de
# maandeinden erbij -- daar vielen de horizongrens en de weekends samen.
if [ "$#" -gt 0 ]; then
  DATUMS=("$@")
else
  DATUMS=()
  for m in 0 3 6 9 12 15 18 21 24 30 36 48 60; do
    DATUMS+=("$(date -d "$(date +%Y-%m-01) +$m months" +%Y-%m-15)")
    DATUMS+=("$(date -d "$(date +%Y-%m-01) +$((m + 1)) months -1 day" +%Y-%m-%d)")
  done
fi

WERK="$(mktemp -d)"
trap 'PGPORT=$PORT "$PGBIN/pg_ctl" -D "$WERK/data" stop -m immediate >/dev/null 2>&1; rm -rf "$WERK"' EXIT
"$PGBIN/initdb" -D "$WERK/data" -A trust >/dev/null

# Een kopie van de harnas die na een fout doorloopt, zodat elke datum ALLE
# fouten toont en niet alleen de eerste.
sed 's/^\\set ON_ERROR_STOP on/\\set ON_ERROR_STOP off/' "$SCRIPT_DIR/recurrence_engine_test.sql" > "$WERK/alles.sql"
sed -e 's/ON_ERROR_STOP=1/ON_ERROR_STOP=0/' \
    -e "s#\$SCRIPT_DIR/recurrence_engine_test.sql#$WERK/alles.sql#" \
    -e "s#\$SCRIPT_DIR/00_local_auth_stub.sql#$SCRIPT_DIR/00_local_auth_stub.sql#" \
    -e "s#MIGRATIONS_DIR=.*#MIGRATIONS_DIR=\"$SCRIPT_DIR/../migrations\"#" \
    "$SCRIPT_DIR/run_recurrence_tests.sh" > "$WERK/run.sh"

fouten=0
for datum in "${DATUMS[@]}"; do
  LD_PRELOAD="$FAKETIME_LIB" FAKETIME="@$datum 09:00:00" \
    "$PGBIN/pg_ctl" -D "$WERK/data" -o "-p $PORT -k $WERK" -l "$WERK/pg.log" start -w >/dev/null
  PGHOST="$WERK" PGPORT="$PORT" bash "$WERK/run.sh" > "$WERK/uit.log" 2>&1
  "$PGBIN/pg_ctl" -D "$WERK/data" stop -m fast -w >/dev/null

  pass=$(grep -c 'NOTICE:  PASS' "$WERK/uit.log")
  skip=$(grep -c 'NOTICE:  SKIP' "$WERK/uit.log")
  fail=$(grep -c 'ERROR:  ' "$WERK/uit.log")
  printf '%s  PASS=%-4s SKIP=%-3s FAIL=%s' "$datum" "$pass" "$skip" "$fail"
  if [ "$fail" -gt 0 ]; then
    fouten=$((fouten + fail))
    printf '\n'; grep -E 'ERROR:  ' "$WERK/uit.log" | sed 's/.*ERROR:  /    /' | sort -u
  else
    printf '\n'
  fi
done

if [ "$fouten" -gt 0 ]; then
  echo "==> $fouten fout(en) over ${#DATUMS[@]} datums."; exit 1
fi
echo "==> Alle ${#DATUMS[@]} datums groen."
