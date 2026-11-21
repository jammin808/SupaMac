# infra/self-hosted

## What it is

The fork's own deployment: the backend as one Docker Compose project on one
VPS, behind a Traefik that is already there. It replaces AWS with containers
on the box. The Pulumi stacks next to it are upstream's AWS and are not used.

## Start here

- `README.md`: how the pieces fit, deployment order, what is not verified.
- `compose.yaml`: the stack; the comment at its top lists what must stay true.
- `ops/config/gateway/Caddyfile`: the public routes and every deny rule.
- `ops/Dockerfile`: the ops image, built from the repository root.

## Scope

- Owns: the Compose files, the ops image (config, scripts, Bun programs) and,
  in `images/`, the Dockerfiles of the other images the fork builds.
- Not here: the workflow that builds and pushes the images → the fork's
  workflows; the web bundle → `docs/supamac/static-publishing.md`; developer
  stacks → `xtask_local`.

## Recipes

- Add a service setting: `x-rust-env` in `compose.yaml`, with the name
  `xtask_local`'s `local_env.rs` uses. A secret goes into the bootstrap
  script instead, and into README's rotation table.
- Add a queue: `resources.rs` → `ops/config/elasticmq/elasticmq.conf` →
  `x-rust-env`. A bucket or table: `resources.rs` → `ops/scripts/init-aws.sh`
  → `x-rust-env`.
- Add a volume: give it a `name:` in `compose.yaml`. One that holds data
  nothing else can rebuild also goes into `ops/scripts/backup.sh`,
  `ops/scripts/restore.sh`, the `backup` container's mounts and
  `restore.compose.yaml`.
- Add a public route: `ops/config/gateway/Caddyfile`, with the prefix
  `xtask_local`'s `proxy.rs` and the web client's `servers.ts` use.
- Change the bootstrap script: it is inline in `bootstrap.compose.yaml` with
  every `$` doubled. Extract it, undouble, and run it against a scratch
  directory before committing.

## Checks

- `docker compose --env-file example.env -f compose.yaml config`, also with
  `COMPOSE_PROFILES=email,search`; set `SUPAMAC_SECRETS_DIR` to a directory
  that holds a `generated.env`.
- `bun test` in `ops/src`; `sh -n` on `ops/scripts/*.sh`; Biome through
  `bun run --cwd infra lint`.
- `docker build -f infra/self-hosted/ops/Dockerfile .` from the repository
  root: validates both Caddy files and runs the tests.

## Gotchas

- Never start this stack to "try it" on a shared machine: it wants 11 GB.
- Compose cannot put an `env_file` value into another value. Anything built
  from a secret (a database URL) is written whole by the bootstrap script.
- `environment:` wins over `env_file:`, so a variable the owner may set in
  `secrets.env` must not be in `compose.yaml`; its stand-in is in
  `generated.env`.
- The endpoint host `localstack`, the account id `000000000000` and the
  alias `document_storage_service` are read by code and built-in config.
- A third-party container gets its config from the `config` volume, the
  KMS from `kms_seed`, and each carries the `supamac.ops-image` label, or it
  keeps old config after an upgrade.
- `restore.compose.yaml` repeats the Postgres and MinIO services, health
  checks included, and mounts the main project's volumes by their names.
- A health check runs inside its container, with that image's tools. The
  MinIO image has bash, coreutils and `mc`: no grep, no HTTP client, no tar.
- A health check of a store proves what its dependants use: Postgres over
  TCP, not its socket, which also answers during first-start setup.
- The backup container mounts state volumes read-only. SQLite cannot open a
  write-ahead-log database from there, so `backup.sh` copies files and
  repeats the copy until none changed during it.
- No real domain, address, name or secret in any file: the repository is
  public.

## Related

- Rules: `.agents/rules/config-and-service-urls.md` · Docs:
  `docs/supamac/deployment.md`, `docs/supamac/self-hosting.md`
