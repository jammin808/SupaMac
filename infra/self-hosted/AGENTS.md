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

- Owns: the Compose files, the ops image (config, scripts, Bun programs,
  the jobs service in `ops/jobs`) and, in `images/`, the Dockerfiles of the
  other images the fork builds.
- Not here: the workflow that builds and pushes the images → the fork's
  workflows; the web bundle → `docs/supamac/static-publishing.md`; developer
  stacks → `xtask_local`.

## Recipes

- Add a service setting: `x-rust-env` in `compose.yaml`, with the name
  `xtask_local`'s `local_env.rs` uses. A secret goes into the bootstrap
  script instead, and into README's rotation table.
- Add a queue, or change one's attributes: `resources.rs` →
  `ops/config/elasticmq/elasticmq.conf` → the `queue` lines of
  `ops/scripts/init-aws.sh` → `x-rust-env`, as `OVERRIDE_<type name in
  macro_queues>` with the queue's URL. `bun test` in `ops/src`, run from the
  checkout, fails until the four agree; the ops image's build has no
  `resources.rs` and skips that comparison. A bucket or table:
  `resources.rs` → `ops/scripts/init-aws.sh` → `x-rust-env`.
- Add a long-running dependency of a Rust service: `condition:
  service_healthy` with `restart: true`.
- Add a volume: give it a `name:` in `compose.yaml`. One that holds data
  nothing else can rebuild also goes into `ops/scripts/backup.sh`,
  `ops/scripts/restore.sh`, the `backup` container's mounts and
  `restore.compose.yaml`.
- Let the jobs service reach another internet host: add its `host:port` to
  `jobs-egress`'s `JOBS_EGRESS_ALLOW` in `compose.yaml`, and to the hosts
  `docs/supamac/jobs.md` (Security) and README's jobs section name. A
  setting of the service: a secret or the owner's choice goes into
  `jobs.env` (`add_secret jobs`, and README's rotation table if it
  rotates), wiring into the `jobs` service's `environment:`, and the
  `add_secret` snippet's list of names it refuses for `jobs.env`.
- Add a public route: `ops/config/gateway/Caddyfile`, with the prefix
  `xtask_local`'s `proxy.rs` and the web client's `servers.ts` use.
- Change the bootstrap script: it is inline in `bootstrap.compose.yaml` with
  every `$` doubled. Extract it, undouble, and run it against a scratch
  directory before committing.

## Checks

- `docker compose --env-file example.env -f compose.yaml config`, also with
  `COMPOSE_PROFILES=email,search` and with `COMPOSE_PROFILES=jobs`; set
  `SUPAMAC_SECRETS_DIR` to a directory that holds a `generated.env`.
- `bun test` and `bun run check` in `ops/jobs`, a package of its own: the
  ops image's build runs its tests without optional dependencies, the
  fork's CI with them.
- `bun test` in `ops/src`, from the checkout: only there do the tests reach
  the local stack's queue catalogue and `compose.yaml`. `sh -n` on
  `ops/scripts/*.sh`; Biome through `bun run --cwd infra lint`.
- `docker build -f infra/self-hosted/ops/Dockerfile .` from the repository
  root: validates the Caddy files and runs the tests.

## Gotchas

- Never start this stack to "try it" on a shared machine: its limits add up
  to 12 GB.
- The queue service refuses a bare queue name where AWS accepts one. A queue
  a service names without its URL fails every poll with a 400.
- The network's DNS answers are kept ten minutes by the Rust services. A
  service that outlives a replaced dependency calls the old address until
  then, hence `restart: true`.
- A container with no health check hides a process that never listened: the
  AI editing worker did, for want of memory.
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
- The queue service's database wins over its config: the config creates a
  queue that is missing and changes none that is there. A changed attribute
  reaches a deployed stack through `init-aws.sh` only.
- `init-aws.sh` runs in the AWS CLI image: that CLI and the shell's builtins,
  no `jq`, and no `grep` or `sed` to count on.
- A health check runs inside its container, with that image's tools. The
  MinIO image has bash, coreutils and `mc`: no grep, no HTTP client, no tar.
- A health check of a store proves what its dependants use: Postgres over
  TCP, not its socket, which also answers during first-start setup.
- The backup container mounts state volumes read-only. SQLite cannot open a
  write-ahead-log database from there, so `backup.sh` copies files and
  repeats the copy until none changed during it.
- The jobs service gets `jobs.env` and no other env file, and refuses to
  start with the internal key or the database URL in its environment. Its
  mailbox host and port are deploy variables (`SUPAMAC_JOBS_MAIL_HOST`,
  `SUPAMAC_JOBS_MAIL_PORT`), because `jobs-egress`'s allow-list is made
  from them and the proxy gets no secret.
- The `jobs` network is internal and isolated (`x-isolated`: no address on
  its bridge, Docker Engine 28 or later): a jobs container reaches
  `jobs-gateway` and `jobs-egress` and nothing else, the VPS's own
  listeners included. Never put the main gateway on it: its `/unfurl` and
  `/image-proxy` fetch any address. Set `HTTPS_PROXY` there, never
  `HTTP_PROXY`: Bun sends an `http://` URL to an `HTTP_PROXY` as a plain
  request, which the proxy refuses, and the jobs gateway is plain HTTP.
- The jobs service calls `jobs-gateway` on port 8081
  (`ops/config/jobs-gateway/Caddyfile`), which serves `/dss` and GET under
  `/local-storage` only and trusts no `X-Forwarded-For`. A route the
  service starts to use goes there; its deny rules repeat the main
  gateway's word for word (`ops/src/jobs-gateway.test.ts`).
- The jobs service parses no file itself: `jobs-extract` does, with no env
  file, no volume and a network (`jobs-extract`) shared with `jobs` alone.
  Never give it `jobs.env`, the state volume or another network: a health
  check or `docker exec` in `jobs` carries every jobs secret, so no parser
  may run beside it.
- The ops image's base is Postgres's, which declares a volume at
  `/var/lib/postgresql`. A read-only container of the ops image mounts a
  tmpfs there, or Docker gives it a writable anonymous volume.
- No real domain, address, name or secret in any file: the repository is
  public.

## Related

- Rules: `.agents/rules/config-and-service-urls.md` · Docs:
  `docs/supamac/deployment.md`, `docs/supamac/self-hosting.md`
