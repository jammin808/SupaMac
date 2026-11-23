#!/bin/sh
# Creates FusionAuth's own role and database, so FusionAuth never holds the
# cluster owner's password. The role's password follows DATABASE_PASSWORD on
# every run, which is what makes rotating it a redeploy.
set -eu

psql "$DATABASE_URL" --no-psqlrc -v ON_ERROR_STOP=1 -v password="$DATABASE_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE fusionauth LOGIN PASSWORD %L', :'password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fusionauth') \gexec

SELECT format('ALTER ROLE fusionauth PASSWORD %L', :'password') \gexec

SELECT 'CREATE DATABASE fusionauth OWNER fusionauth'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'fusionauth') \gexec
SQL

echo "role and database fusionauth exist"
