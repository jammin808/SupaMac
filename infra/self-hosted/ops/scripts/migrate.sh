#!/bin/sh
# Applies the MacroDB migrations. Runs before any service starts.
set -eu

# The baseline migration creates the schema only when `public` is empty and
# otherwise does nothing, yet is recorded as applied; every later migration
# then fails on missing tables. A database that has tables but no migration
# history is therefore not ours to migrate.
state=$(psql "$DATABASE_URL" --no-psqlrc -v ON_ERROR_STOP=1 -At -F ' ' <<'SQL'
SELECT
  (SELECT count(*) FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name <> '_sqlx_migrations'),
  to_regclass('public._sqlx_migrations') IS NOT NULL;
SQL
)
relations=${state% *}
has_history=${state#* }

if [ "$relations" -gt 0 ] && [ "$has_history" != t ]; then
  echo "The database has $relations tables or views in schema public and no _sqlx_migrations table." >&2
  echo "Refusing to migrate: DATABASE_URL must name an empty database of its own." >&2
  exit 1
fi

exec sqlx migrate run --source /opt/supamac/migrations
