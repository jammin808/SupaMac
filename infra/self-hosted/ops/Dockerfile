# syntax=docker/dockerfile:1
#
# The ops image: the stack's config files, its one-shot scripts, the sqlx CLI
# with the MacroDB migrations, the small Bun programs and the jobs service.
#
# The build context is the repository root, because the migrations, the event
# topic list, the search index script, the FusionAuth lambda and the storage
# API's description the jobs tests check against live outside this
# directory:
#
#   docker build -f infra/self-hosted/ops/Dockerfile -t <ops image> .
#
# Nothing in this image is secret. It is public by design.

FROM rust:1.94-slim-bookworm@sha256:cf9dd0ec73e75f827fe59123fff9dc65af1a1c8363c3c31ee8d7f8ad0b6a5fb2 AS sqlx
# The version the migrations were last applied with to this Postgres image.
RUN cargo install sqlx-cli --version 0.9.1 --locked \
    --no-default-features --features postgres,rustls --root /out

# A config that does not parse fails the build, not the deployment.
FROM caddy:2-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0 AS caddy-check
COPY infra/self-hosted/ops/config/gateway/Caddyfile /check/gateway/Caddyfile
COPY infra/self-hosted/ops/config/jobs-gateway/Caddyfile /check/jobs-gateway/Caddyfile
COPY infra/self-hosted/ops/config/router/Caddyfile /check/router/Caddyfile
RUN SUPAMAC_UI_ORIGIN=https://example.com \
      caddy validate --adapter caddyfile --config /check/gateway/Caddyfile \
    && SUPAMAC_UI_ORIGIN=https://example.com \
      caddy validate --adapter caddyfile --config /check/jobs-gateway/Caddyfile \
    && caddy validate --adapter caddyfile --config /check/router/Caddyfile \
    && touch /check/passed

# Bun 1.4: the jobs package's lockfile is in the format Bun 1.4 writes, which
# Bun 1.3 refuses. The image's one Bun runs every program in it.
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS bun
WORKDIR /opt/supamac/search-indices
COPY infra/stacks/opensearch/helpers/package.json infra/stacks/opensearch/helpers/bun.lock ./
RUN bun install --frozen-lockfile
COPY infra/stacks/opensearch/helpers/ ./
WORKDIR /opt/supamac
COPY infra/self-hosted/ops/config/ config/
COPY infra/self-hosted/ops/scripts/ scripts/
COPY infra/self-hosted/ops/src/ src/
RUN cd src && bun test \
    && for script in /opt/supamac/scripts/*.sh; do sh -n "$script"; done

# The jobs service. Its tests read the storage API's description where the
# checkout keeps it, so this stage repeats the checkout's layout. Optional
# dependencies are left out, here and in the image: the PDF library runs
# without its canvas. The image gets production dependencies only.
FROM bun AS jobs
WORKDIR /checkout/infra/self-hosted/ops/jobs
COPY infra/self-hosted/ops/jobs/package.json infra/self-hosted/ops/jobs/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts --omit=optional
COPY packages/sdk/specs/storage.json /checkout/packages/sdk/specs/storage.json
COPY infra/self-hosted/ops/jobs/tsconfig.json ./
COPY infra/self-hosted/ops/jobs/src/ src/
COPY infra/self-hosted/ops/jobs/test/ test/
RUN bun test
RUN rm -rf node_modules \
    && bun install --frozen-lockfile --ignore-scripts --omit=optional --production \
    && mkdir /out \
    && cp -R package.json src node_modules /out/

FROM cgr.dev/chainguard/minio@sha256:e9cf6b99c226e9539ed0f14b6f00e37b07da153c7ba1f4f8709c807574b471ec AS minio

# The database's own image, the one compose.yaml runs: its psql, pg_dump and
# pg_restore are never older than the server they talk to.
FROM pgvector/pgvector:pg18@sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782

COPY --from=sqlx /out/bin/sqlx /usr/local/bin/sqlx
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
# The object store's client, from the object store's image.
COPY --from=minio /usr/bin/mc /usr/local/bin/mc
# Unused stages are skipped, so the check has to hand something over.
COPY --from=caddy-check /check/passed /opt/supamac/.config-checked

# Each copied program runs on this base.
RUN sqlx --version && bun --version && mc --version && pg_dump --version

COPY --from=bun /opt/supamac/ /opt/supamac/
COPY --from=jobs /out/ /opt/supamac/jobs/
COPY infra/stacks/fusionauth-instance/templates/populate_jwt_local.js /opt/supamac/config/fusionauth/populate_jwt.js
COPY .github/kafka-cluster-topics.json /opt/supamac/config/kafka/topics.json
COPY crates/macro_db_client/migrations/ /opt/supamac/migrations/

# Every container names the script or program it runs.
ENTRYPOINT []
CMD ["sh", "-c", "echo 'the ops image runs a script from /opt/supamac/scripts, a program from /opt/supamac/src or the jobs service in /opt/supamac/jobs' >&2; exit 64"]
