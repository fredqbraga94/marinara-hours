#!/usr/bin/env bash
# Isolated database test: throwaway local PostgreSQL with the production
# STRUCTURE (no production data), the migration under test, and assertions.
# Nothing here connects to Supabase.
#
# Usage: tests/db/run.sh            (needs PostgreSQL 14+ binaries and pgcrypto)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-55432}"
export PGHOST="$WORK" PGPORT="$PORT"

cleanup() { "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

RUNAS=()
if [ "$(id -u)" = "0" ]; then
  id pgtest >/dev/null 2>&1 || useradd -M -s /bin/false pgtest
  chown -R pgtest "$WORK"
  RUNAS=(runuser -u pgtest --)
fi

"${RUNAS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-k $WORK -p $PORT -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null

cd "$ROOT"
psql_run() { psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }

psql_run -f "$HERE/schema_snapshot.sql" >/dev/null
echo "schema snapshot loaded"

for m in "$@"; do
  psql_run -f "$ROOT/$m" >/dev/null
  echo "applied $m"
done

psql_run -f "$HERE/assertions.sql"
echo "ALL DATABASE ASSERTIONS PASSED"
