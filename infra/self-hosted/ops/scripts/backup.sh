#!/bin/sh
# One backup of everything that is not rebuildable: both databases, every
# object, and the five volumes that hold state of their own. Writes
# /backups/<UTC time>/ and keeps the newest BACKUP_KEEP of them.
#
# Not here, because each is rebuilt or refilled: Redis, Kafka, the queue
# service and OpenSearch. Also not here: /etc/supamac, without which a
# restored instance can neither decrypt stored credentials nor verify sessions.
set -eu
umask 077

keep=${BACKUP_KEEP:-7}
stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
work=/backups/incomplete-$stamp

# Every file of a volume with its size and the time it was last written.
state_of() {
  find "$1" -type f -printf '%P %s %T@\n' | sort
}

# A volume is copied while its service runs. The sync service and DynamoDB
# Local keep SQLite files; the jobs service replaces its state file whole
# beside spooled sources. A copy during which no file changed is the volume
# as it stood at one moment, which SQLite opens as it would after its process
# stopped there; a copy that overlaps a write may be no state it ever had.
# So the copy is taken again, up to five times, until nothing changed during
# it. A volume that is never quiet keeps its last copy, and the log says so.
copy_volume() {
  volume=$1

  for attempt in 1 2 3 4 5; do
    before=$(state_of "/volumes/$volume")

    # tar exits 1 when a file changed or went while it was read, 2 when the
    # archive could not be written.
    status=0
    tar -C "/volumes/$volume" -czf "$work/$volume.tar.gz" . || status=$?
    if [ "$status" -gt 1 ]; then
      return "$status"
    fi

    if [ "$status" -eq 0 ] && [ "$before" = "$(state_of "/volumes/$volume")" ]; then
      return 0
    fi
    sleep 2
  done

  echo "warning: $volume was written to during each of $attempt copies; its copy may be inconsistent" >&2
}

# A folder is renamed to its final name only when every part is in it, so a
# dated folder is always a whole backup.
find /backups -mindepth 1 -maxdepth 1 -type d -name 'incomplete-*' -exec rm -rf {} +
mkdir -p "$work/objects"

pg_dump --format=custom --file="$work/macrodb.dump" "$DATABASE_URL"
pg_dump --format=custom --file="$work/fusionauth.dump" "${DATABASE_URL%/*}/fusionauth"

# Objects are read through the store's API, each one whole, instead of copying
# the store's files while it writes them. The folder holds each object's bytes
# under its key and nothing else: not its content type or other metadata.
export MC_HOST_store="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@minio:9000"
mc mirror --quiet store "$work/objects"

# The KMS keys can also be recreated from generated.env. The jobs state
# holds the Telegram link, the pinned ids of the Jobs database, the saved
# model replies and what the checks know of each detail: nothing else has
# them. Without the jobs profile its volume is empty and copied all the same.
for volume in dynamodb kms sync-state agent-git jobs-state; do
  copy_volume "$volume"
done

mv "$work" "/backups/$stamp"
echo "backup $stamp complete"

find /backups -mindepth 1 -maxdepth 1 -type d -name '20*Z' | sort -r | tail -n "+$((keep + 1))" |
  while read -r old; do
    rm -rf "$old"
    echo "removed $(basename "$old")"
  done
