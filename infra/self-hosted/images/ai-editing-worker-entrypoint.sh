#!/bin/sh
# Starts the AI editing worker under wrangler's local runtime.
#
# Read from the environment:
#
#   OPENAI_API_KEY, ANTHROPIC_API_KEY, CEREBRAS_API_KEY
#       The worker refuses every request unless all three are set.
#   GOOGLE_GENERATIVE_AI_API_KEY, TRACE_ADMIN_KEY, INTERNAL_API_KEY
#       Optional.
#   SYNC_WS_BASE, DSS_BASE, SEARCH_SERVICE_BASE, CONTACTS_SERVICE_BASE,
#   AUTH_SERVICE_BASE, CANVAS_RENDER_URL, CANVAS_BROWSER_URL, ENVIRONMENT
#       Optional. Each replaces the value `[env.local.vars]` gives it in
#       wrangler.toml, which names the services by their compose host names
#       (sync-service:8787, document-storage-service:8080 and so on).
#   ALLOWED_ORIGINS
#       The browser origins that may read the worker's answers,
#       comma-separated, each as a browser sends it in `Origin`. Unset or
#       empty, only loopback development origins and the desktop app may.
#   APP_URL, STATIC_FILE_URL
#       The web app's origin and folder, and the static-file service's public
#       URL, for links in the documents the worker converts. Unset, video
#       embeds and booking links of the instance are not recognised.
#   OTEL_EXPORTER_OTLP_ENDPOINT
#       Where traces are sent. Unset, none are.
#   STATE_DIR
#       Where the worker's state is kept. /data unless set.
set -eu

state="${STATE_DIR:-/data}"

# wrangler gives the worker its secrets from this file, not from the process
# environment. Only this user can read it.
(
  umask 077
  for name in \
    OPENAI_API_KEY \
    ANTHROPIC_API_KEY \
    CEREBRAS_API_KEY \
    GOOGLE_GENERATIVE_AI_API_KEY \
    TRACE_ADMIN_KEY \
    INTERNAL_API_KEY
  do
    value=$(printenv "$name" || true)
    if [ -n "$value" ]; then
      printf '%s=%s\n' "$name" "$value"
    fi
  done > .dev.vars
)

wrangler=/app/node_modules/wrangler/bin/wrangler.js

# The edit-trace table. Applying it again changes nothing.
node "$wrangler" d1 migrations apply TRACES_DB --local --env local --persist-to "$state"

# An unset endpoint is passed empty, which turns trace export off; otherwise
# the worker would keep the local stack's collector, which is not here.
set -- --var "OTEL_EXPORTER_OTLP_ENDPOINT:${OTEL_EXPORTER_OTLP_ENDPOINT:-}"
for name in \
  ALLOWED_ORIGINS \
  APP_URL \
  STATIC_FILE_URL \
  SYNC_WS_BASE \
  DSS_BASE \
  SEARCH_SERVICE_BASE \
  CONTACTS_SERVICE_BASE \
  AUTH_SERVICE_BASE \
  CANVAS_RENDER_URL \
  CANVAS_BROWSER_URL \
  ENVIRONMENT
do
  value=$(printenv "$name" || true)
  if [ -n "$value" ]; then
    set -- "$@" --var "$name:$value"
  fi
done

exec node "$wrangler" dev --env local --ip 0.0.0.0 --port 8933 --persist-to "$state" "$@"
