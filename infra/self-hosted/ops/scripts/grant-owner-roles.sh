#!/bin/sh
# Gives the accounts in OWNER_EMAILS (comma-separated) the roles a paid plan
# carries, so the owner can use every AI model without a Stripe subscription.
#
# An account exists only after its first sign-in, so this runs on every
# deployment and grants to those that exist by then: sign in once, deploy
# again. Roles already held are left as they are.
set -eu

if [ -z "${OWNER_EMAILS:-}" ]; then
  echo "OWNER_EMAILS is empty: nothing to grant"
  exit 0
fi

# Counts only: the addresses are personal data and stay out of the log.
psql "$DATABASE_URL" --no-psqlrc -v ON_ERROR_STOP=1 -At -v emails="$OWNER_EMAILS" <<'SQL'
WITH owners AS (
  SELECT DISTINCT 'macro|' || lower(btrim(email)) AS user_id
  FROM unnest(string_to_array(:'emails', ',')) AS email
  WHERE btrim(email) <> ''
),
signed_in AS (
  SELECT owners.user_id
  FROM owners
  JOIN "User" ON "User"."id" = owners.user_id
),
granted AS (
  INSERT INTO "RolesOnUsers" ("userId", "roleId")
  SELECT signed_in.user_id, role.id
  FROM signed_in
  CROSS JOIN (VALUES ('professional_subscriber'), ('sub_opus')) AS role (id)
  ON CONFLICT DO NOTHING
  RETURNING 1
)
SELECT format(
  '%s of %s owner accounts have signed in; %s role grants added',
  (SELECT count(*) FROM signed_in),
  (SELECT count(*) FROM owners),
  (SELECT count(*) FROM granted)
);
SQL
