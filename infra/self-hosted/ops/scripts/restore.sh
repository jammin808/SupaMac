#!/bin/sh
# Puts one backup folder back: both databases, every object and the four
# state volumes. Everything they hold now is replaced. An object comes back
# with its bytes and the content type its key's extension stands for, which
# is none for a key without one: the backup holds no object metadata.
#
# Run from restore.compose.yaml while the main project is stopped: the
# databases are dropped and the volumes are emptied underneath whatever uses
# them. Afterwards deploy the main project again, which reapplies migrations
# newer than the backup and the bucket settings.
set -eu

name=${1:?usage: restore.sh <backup folder name, as backup.sh logged it>}
source=/backups/$name

for part in macrodb.dump fusionauth.dump objects \
  dynamodb.tar.gz kms.tar.gz sync-state.tar.gz agent-git.tar.gz
do
  if [ ! -e "$source/$part" ]; then
    echo "$source/$part is missing: not a complete backup" >&2
    exit 1
  fi
done

/opt/supamac/scripts/init-fusionauth-db.sh

server=${DATABASE_URL%/*}
psql "$server/postgres" --no-psqlrc -v ON_ERROR_STOP=1 <<'SQL'
DROP DATABASE IF EXISTS macrodb WITH (FORCE);
CREATE DATABASE macrodb;
DROP DATABASE IF EXISTS fusionauth WITH (FORCE);
CREATE DATABASE fusionauth OWNER fusionauth;
SQL

pg_restore --exit-on-error --no-owner --dbname="$DATABASE_URL" "$source/macrodb.dump"
# As FusionAuth's own role, so that it owns what it restores.
pg_restore --exit-on-error --no-owner \
  --dbname="postgres://fusionauth:$DATABASE_PASSWORD@postgres:5432/fusionauth" \
  "$source/fusionauth.dump"

export MC_HOST_store="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000"
for bucket in "$source"/objects/*/; do
  # No folder at all leaves the pattern itself in the loop.
  [ -d "$bucket" ] || continue
  bucket=$(basename "$bucket")
  mc mb --ignore-existing "store/$bucket"
  mc mirror --quiet --overwrite --remove "$source/objects/$bucket" "store/$bucket"
done

for volume in dynamodb kms sync-state agent-git; do
  find "/volumes/$volume" -mindepth 1 -delete
  tar -C "/volumes/$volume" -xzf "$source/$volume.tar.gz"
done

echo "restore of $name complete"
