# syntax=docker/dockerfile:1
#
# The lexical service of a self-hosted instance: a Bun server that converts
# rich-text documents. It keeps no state.
#
# Build context: the repository root. BuildKit reads
# `lexical-service.Dockerfile.dockerignore`, beside this file, in place of the
# root `.dockerignore`, which leaves out the packages this build needs:
#
#   docker buildx build --file infra/self-hosted/images/lexical-service.Dockerfile .
#
# The server listens on PORT (8096) and exits at start unless INTERNAL_AUTH_KEY,
# SYNC_SERVICE_AUTH_KEY and SYNC_SERVICE_URL are set. It answers GET /health.
#
# Base images are pinned by digest (resolved 2026-11-21). To move one, take the
# index digest `docker buildx imagetools inspect <image>:<tag>` prints.
FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS build
WORKDIR /src
COPY . .

# The lexical service's own dependencies, not the whole workspace's. No
# package it imports needs an install script.
RUN bun install --frozen-lockfile --ignore-scripts --filter lexical-service

# Run a bundle, not the TypeScript entry: unbundled, Bun evaluates the circular
# @lexical/* imports in an order that reads a class before it is initialised.
# loro-crdt stays outside the bundle because bundling it emits its WebAssembly
# as a second output file and mis-wires how it is loaded; it is copied beside
# the bundle instead, where the bundle's import resolves.
WORKDIR /src/services/lexical-service
RUN bun build src/server.ts --target=bun --external loro-crdt --outfile=/out/server.bundle.js \
    && mkdir /out/node_modules \
    && cp -R /src/node_modules/loro-crdt /out/node_modules/loro-crdt

FROM oven/bun:1.4.5-slim@sha256:b780593f3e10918cbdaec3d5a08d52224b9198069a65eb47812085c2ec007643
WORKDIR /app
COPY --from=build /out/ /app/
ENV PORT=8096
EXPOSE 8096
USER bun
CMD ["bun", "/app/server.bundle.js"]
