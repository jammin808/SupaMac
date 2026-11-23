#!/bin/sh
# Prepares the volumes third-party containers and the jobs service start
# from. Runs first on every deployment and leaves the same state however
# often it runs.
set -eu

image=/opt/supamac
config_volume=/volumes/config
kms_seed_volume=/volumes/kms-seed
dynamodb_volume=/volumes/dynamodb
jobs_state_volume=/volumes/jobs-state

# The config volume holds this image's config and scripts and nothing else,
# so a file dropped from the image is also gone from the volume.
find "$config_volume" -mindepth 1 -delete
cp -R "$image/config" "$image/scripts" "$config_volume/"

# The KMS seed holds key material, so it goes to a volume only the KMS
# container mounts, not to the config volume.
seed=$(cat "$image/config/kms/seed.template.yaml")
for name in \
  KMS_KEY_CURSOR_API_KEY \
  KMS_KEY_CODEX_OAUTH \
  KMS_KEY_MCP_OAUTH \
  KMS_KEY_MICROSOFT_TOKEN \
  KMS_KEY_WHATSAPP_SESSION
do
  value=$(printenv "$name" || true)
  case $value in
    '' | *[!0-9a-f]*)
      echo "$name must be 64 hex characters; it comes from generated.env" >&2
      exit 1
      ;;
  esac
  if [ "${#value}" -ne 64 ]; then
    echo "$name must be 64 hex characters; it comes from generated.env" >&2
    exit 1
  fi
  seed=$(printf '%s\n' "$seed" | sed "s/{{$name}}/$value/")
done
(umask 077 && printf '%s\n' "$seed" > "$kms_seed_volume/seed.yaml")

# DynamoDB Local runs as uid 1000 and cannot create its database in a volume
# Docker made for root.
chown 1000:1000 "$dynamodb_volume"

# The jobs service runs as uid 65534 with a read-only root: its state volume
# is the one place it writes, and nobody else's. Only the volume itself is
# handed over; what is in it the service wrote, or a restore put back with
# its owners.
chown 65534:65534 "$jobs_state_volume"
chmod 700 "$jobs_state_volume"

echo "config volume, KMS seed, DynamoDB and jobs state volumes are ready"
