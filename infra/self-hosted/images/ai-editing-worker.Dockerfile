# syntax=docker/dockerfile:1
#
# The AI editing worker of a self-hosted instance. It is a Cloudflare Worker,
# and outside Cloudflare the repository runs it one way: under `wrangler dev`,
# wrangler's local runtime, which bundles the worker from source when it
# starts. The image therefore holds the worker's sources, the workspace
# packages it imports and their dependencies; nothing is mounted from a
# checkout.
#
# Build context: the repository root. BuildKit reads
# `ai-editing-worker.Dockerfile.dockerignore`, beside this file, in place of
# the root `.dockerignore`, which leaves out the packages this build needs:
#
#   docker buildx build --file infra/self-hosted/images/ai-editing-worker.Dockerfile .
#
# The worker listens on 8933 and runs as uid and gid 1000. Its state, the
# local database of edit traces, is under /data: mount a volume there.
# `ai-editing-worker-entrypoint.sh` lists the environment it reads.
#
# Base images are pinned by digest (resolved 2026-11-21). To move one, take the
# index digest `docker buildx imagetools inspect <image>:<tag>` prints.
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS bun

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY . .

# The worker's own dependencies, wrangler among them, not the whole
# workspace's. wrangler and its runtime start without their install scripts.
RUN bun install --frozen-lockfile --ignore-scripts --filter ai-editing-worker

# The editor code the worker runs in its sandbox, generated from its sources.
RUN cd services/ai-editing-worker && bun scripts/generate-sandbox.ts

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates dumb-init \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app
COPY --chmod=0755 infra/self-hosted/images/ai-editing-worker-entrypoint.sh /usr/local/bin/ai-editing-worker-entrypoint

# wrangler writes its bundle and the secrets file beside the worker, and the
# worker's state under /data. Nothing else in the image is writable by it.
RUN install --directory --owner node --group node /data \
    && chown -R node:node /app/services/ai-editing-worker

# wrangler asks nothing and reports no usage.
ENV CI=true \
    WRANGLER_SEND_METRICS=false \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app/services/ai-editing-worker
EXPOSE 8933
USER node
ENTRYPOINT ["dumb-init", "--", "ai-editing-worker-entrypoint"]
