# syntax=docker/dockerfile:1
#
# Runtime image for the Rust services of a self-hosted instance, one image for
# all of them. `.github/workflows/supamac-images.yml` compiles the binaries on
# the runner and builds this file from a context that holds nothing else:
#
#   bin/<binary>                   stripped release binaries, default features
#   pdfium-lib/linux/libpdfium.so  the PDF library search_processing_service loads
#
# The image has no default command. A compose service picks its binary:
#
#   command: ["/app/bin/authentication_service"]
#
# It runs as uid and gid 10001. The one path a service writes is the agent
# harness's repository store, `REPO_STORAGE_ROOT=/data/agent-git`: a named
# volume mounted there, or at /data, takes this image's ownership of it.
#
# Base images are pinned by digest (resolved 2026-11-21). To move one, take the
# index digest `docker buildx imagetools inspect <image>:<tag>` prints.
FROM denoland/deno:2.9.6@sha256:2014dc167ece617ef7e7ba40631ac2234c59e75ce693e7cc2dc2602b3c87859d AS deno

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

# curl answers the compose health checks. git serves the agent harness's
# repositories through `git http-backend`; the service refuses to start
# without it. No library is installed for the binaries: OpenSSL, zlib and
# librdkafka are compiled into them, and the workflow fails when a binary
# names a shared library this image lacks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl dumb-init git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Agent code mode runs its sandboxes on this Deno.
COPY --from=deno /usr/bin/deno /usr/local/bin/deno
ENV DENO_BINARY=/usr/local/bin/deno

# search_processing_service opens ./pdfium-lib/linux/libpdfium.so, relative to
# its working directory. The directory is made here because a COPY would give
# the directories it creates the file's mode, which no user can enter.
RUN groupadd --system --gid 10001 supamac \
    && useradd --system --uid 10001 --gid supamac --home-dir /home/supamac --create-home --shell /usr/sbin/nologin supamac \
    && install --directory --owner supamac --group supamac /data /data/agent-git \
    && mkdir -p /app/pdfium-lib/linux

WORKDIR /app
COPY --chmod=0755 bin/ /app/bin/
COPY --chmod=0644 pdfium-lib/linux/libpdfium.so /app/pdfium-lib/linux/libpdfium.so

ENV PORT=8080
EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["dumb-init", "--"]
