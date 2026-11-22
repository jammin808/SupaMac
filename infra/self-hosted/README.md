# Self-hosted backend

The SupaMac backend as one Docker Compose project on one VPS, for one owner
and a few teammates, reached from the internet at `https://api.<domain>`. The
web UI is a static bundle served somewhere else and is not part of this
directory.

**Status: rehearsed once on a development machine, never deployed.** The
default profile was started from empty volumes behind a stand-in for Traefik,
and a person's path through it was driven in a browser: sign-in by mailed
code, a team, a document, an upload, a CRM company and contact, sign-out. What
was run is listed under [What was checked](#what-was-checked); what the
rehearsal could not show, and what it showed to be wrong outside this
directory, is under [Not covered, not verified](#not-covered-not-verified).
Read that list before relying on any part of this.

## What it assumes about the VPS

- Docker with Compose, driven through a tool that takes a Compose file and a
  list of environment variables and shows container logs. No shell is needed
  to deploy; the owner needs a root terminal once, to add third-party keys.
- A Traefik container that is already there, with the Docker provider and
  `exposedByDefault=false`, an entrypoint `websecure` on 443, a certificate
  resolver named `mytlschallenge`, attached to the Docker network
  `n8n_default`. Those three names are written into `compose.yaml`.
- 16 GB of memory shared with what already runs there. The limits of the
  default profile add up to 11.6 GB; idle, the rehearsal measured 3.3 GB in
  use.

## How the pieces fit

```
 browser ── https://<ui origin>/<folder>/        static bundle, hosted elsewhere
    │
    │ https://api.<domain>/<service>/...
    ▼
 Traefik (already on the VPS: TLS, security headers)
    │ network n8n_default
    ▼
 gateway (Caddy) ── deny rules, one route per service, object routes
    │ network `internal` (no route to the internet)
    ├─ authentication-service ── fusionauth ── mail-relay ──► SMTP provider
    ├─ document-storage-service, contacts-service, notification-service,
    │  connection-gateway, static-file-service, unfurl-service,
    │  image-proxy-service, agent-harness-service
    ├─ sync-service, lexical-service, ai-editing-worker
    └─ minio (objects, through /local-storage and /static-file only)

 every service ──► postgres, redis, kafka
 every service ──► router `localstack:4566` ─┬─ X-Amz-Target AmazonSQS.*   ► elasticmq
                                             ├─ X-Amz-Target DynamoDB_*    ► dynamodb
                                             ├─ X-Amz-Target TrentService.*► kms
                                             └─ everything else            ► minio
 minio ── object created ──► upload-relay ──► queue ──► document-upload-finalizer
 scheduler ── each minute ──► reminder queue

 jobs, in order, on every deployment:
   init-volumes ► init-fusionauth-db, migrate, init-kafka-topics, init-aws ► services
```

The Rust services, the sync service and the two Bun services also sit on a
second network, `egress`, which can reach the internet: AI providers, the
SMTP provider, fetched links. The stores cannot.

### Files

| File | What it is |
| --- | --- |
| `bootstrap.compose.yaml` | One-shot project that creates the secrets on the VPS. |
| `compose.yaml` | The stack. |
| `restore.compose.yaml` | One-shot project that puts a backup back. |
| `example.env` | The variables the operator supplies, with placeholders. |
| `ops/` | The ops image: config files, scripts, the sqlx CLI with the migrations, the upload relay and the clock. |
| `images/` | Dockerfiles of the other images the fork builds for this stack. |

### Profiles

| Profile | Adds | Limits add |
| --- | --- | --- |
| default | Sign-in, documents, tasks, CRM and contacts, notifications, static files, upload finalizer, connection gateway, collaborative editing, the AI assistant, reminders, backups | 11.6 GB |
| `email` | Email service and workers, calendar service, the email schedules | 1.6 GB |
| `search` | OpenSearch and the search indexer | 2.0 GB |

The limits are estimates from the settings in the repository. One was
measured and raised: the AI editing worker holds about 1 GB and never
listened under the 512 MB it had. With both optional profiles the stack's
limits alone come to 15.2 GB.

## First deployment

1. **Images.** The fork's GitHub Actions build and push the images to a
   public registry. Take their references; a reference must be immutable (a
   commit tag or a digest).
2. **Bootstrap.** Deploy `bootstrap.compose.yaml` as its own project, with no
   variables. Its log ends with the names of the variables it wrote to
   `/etc/supamac/generated.env`. Remove the project again. Deploying it a
   second time changes nothing.
3. **DNS.** Point `api.<domain>` at the VPS.
4. **The stack.** Deploy `compose.yaml` with the variables of
   [`example.env`](example.env). The jobs run first; the services start when
   the jobs are done. `mail-relay` keeps restarting until step 5: it refuses
   to run without a provider.
5. **Third-party keys.** Add the SMTP provider and any AI keys as described
   under [Adding third-party keys](#adding-third-party-keys), then deploy the
   stack again. Nobody can sign in before the mail relay runs, because the
   sign-in code arrives by mail.
6. **The web bundle.** Build and publish it for
   `https://api.<domain>`; see
   [`docs/supamac/static-publishing.md`](../../docs/supamac/static-publishing.md).
7. **First sign-in.** Sign in with an address from the allow-list. Then
   deploy the stack once more: `grant-owner-roles` gives the accounts in
   `SUPAMAC_OWNER_EMAILS` the paid-plan roles, which it can only do for
   accounts that exist.

Checks worth doing from outside the VPS afterwards:

- `POST https://api.<domain>/auth/login/passwordless` answers without a
  `code` field, and a second request for the same address within 30 seconds
  answers 429. Either failing means the services image was built with the
  developer features.
- `https://api.<domain>/auth/docs`, `/auth/internal/health`,
  `/auth/webhooks/user` and `/dss/items/soup/graphql` (GET) answer 404.
- No port other than Traefik's answers.

## What the operator supplies

In the deploy tool, with the Compose file. None of these is a secret.

| Variable | Meaning |
| --- | --- |
| `SUPAMAC_DOMAIN` | The API is `https://api.<this>`. |
| `SUPAMAC_UI_ORIGIN` | The origin browsers send, `https://example.com`, without path or trailing slash. Every service allows exactly this origin. |
| `SUPAMAC_UI_PATH` | The folder of the bundle below that origin, `/supamac`; empty at the root. |
| `SUPAMAC_SIGNUP_ALLOWLIST_JSON` | JSON array of the only addresses that can create an account. An invited teammate must be on it too. |
| `SUPAMAC_OWNER_EMAILS` | Comma-separated accounts that get the paid-plan roles. Optional. |
| `SUPAMAC_MAIL_DOMAIN` | Domain mail is sent from, if not `SUPAMAC_DOMAIN`. The relay refuses any other sender domain. |
| `SUPAMAC_SERVICES_IMAGE`, `SUPAMAC_OPS_IMAGE`, `SUPAMAC_SYNC_IMAGE`, `SUPAMAC_LEXICAL_IMAGE`, `SUPAMAC_AI_EDITING_IMAGE` | Image references. |
| `COMPOSE_PROFILES` | `email`, `search` or both. Optional. |
| `SUPAMAC_SEARCH_IMAGE` | Needed with the `search` profile. |
| `SUPAMAC_BACKUP_KEEP` | Daily backups kept, default 7. |

On the VPS, in `/etc/supamac` (mode 700, files mode 600, owned by root):

| File | Written by | Holds |
| --- | --- | --- |
| `generated.env` | the bootstrap project, once | Every internal secret: database, Redis and object-store credentials, the shared internal service key, the session signing secret, FusionAuth's API key, client secret and admin password, the token key pair, webhook verification secrets, the KMS key material. Also stand-in values for the AI provider keys. |
| `secrets.env` | the owner | Third-party credentials. Its values win over `generated.env`. |

The deploy tool never reads either file; the containers do, through
`env_file`. A value that spans lines, such as a PEM key, is stored on one
line in double quotes with `\n` between its lines; Compose turns that back
into line breaks, so the service receives the PEM as it is.

## Adding third-party keys

Open the VPS's browser terminal, become root (`sudo -i`), paste this, and
answer the two prompts. The value is not echoed and is written nowhere but
the file.

```bash
add_secret() {
  local file=/etc/supamac/secrets.env name value
  read -rp 'Variable name: ' name
  read -rsp 'Value (it is not shown): ' value
  echo
  if [[ ! $name =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo 'That is not a variable name.'
    return 1
  fi
  if [[ -z $value || $value == *"'"* ]]; then
    echo 'The value is empty or contains a single quote, which the file cannot hold.'
    return 1
  fi
  (
    umask 077
    sed -i "/^${name}=/d" "$file"
    printf "%s='%s'\n" "$name" "$value" >> "$file"
  )
  echo "Saved ${name}. Redeploy the project for it to take effect."
}
add_secret
```

Run `add_secret` again for each further variable. Entering a name a second
time replaces its value. Then deploy the stack again.

| Variable | For |
| --- | --- |
| `RELAYHOST` | The SMTP provider, as `[smtp.example.com]:587`. Required. |
| `RELAYHOST_USERNAME`, `RELAYHOST_PASSWORD` | Its login. |
| `POSTFIX_smtp_tls_wrappermode` | `yes`, only for a provider on port 465. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini, the model every account may use. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORK_API_KEY`, `COHERE_API_KEY` | Further providers. A provider without a key fails when it is used. |

The provider must accept `no-reply@<mail domain>` as a sender, and the mail
domain needs the SPF and DKIM records the provider asks for.

## Rotating a secret

`generated.env` is never rewritten by a tool. To rotate, change the value in
the file by hand, under every name it appears with, and deploy the stack
again; the comments in the file group the names. What follows from a change:

| Secret | Effect, and what else has to happen |
| --- | --- |
| Third-party keys | None. Use `add_secret`. |
| Redis password (five names) | Redis and the services take the new one together. |
| Object-store keys (three pairs) | The store and the services take the new pair together. Links signed with the old pair stop working. |
| `MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_UPLOADS` | None. |
| FusionAuth's database password (`DATABASE_PASSWORD`) | `init-fusionauth-db` sets the role's password on every deployment. |
| `URL_SIGNING_HMAC`, `ACCOUNT_LINK_STATE_SECRET`, `INTERNAL_CALL_SECRET`, the webhook verification secrets | Links and states signed before stop working. |
| The token key pair (two names) | Both together; issued API tokens stop working. |
| `DOCUMENT_PERMISSION_JWT` and `DOCUMENT_PERMISSIONS_SECRET` | Both together. |
| Postgres owner password | Not by redeploying: the database keeps the password it was created with. Change it in the database first. |
| The internal service key, `JWT_SECRET_KEY`, FusionAuth's API key and client secret | Not by redeploying: FusionAuth holds its own copy from the kickstart, which runs once. Change it in FusionAuth through its API as well, or sign-in breaks. No procedure for that is written here. |
| `MCP_CREDENTIALS_KEY_SECRET_NAME`, the `KMS_KEY_*` values | Never: stored credentials encrypted with them become unreadable. |

## Backup and restore

The `backup` container makes a backup when the stack starts and every 24
hours after, into the volume `supamac_backups`, one folder per backup named
by its UTC time, and keeps the newest `SUPAMAC_BACKUP_KEEP`. A backup that
fails is tried again after ten minutes. Its log names each folder. A folder
holds:

- `macrodb.dump`, `fusionauth.dump`: `pg_dump` custom format.
- `objects/<bucket>/`: the bytes of every object under its key, read through
  the object store's API.
- `dynamodb.tar.gz`, `kms.tar.gz`, `sync-state.tar.gz`, `agent-git.tar.gz`:
  the four state volumes, copied while their services run. A copy is taken
  again, up to five times, until no file changed during it; the log has a
  `warning:` line for a volume that was never quiet, whose copy may then be
  inconsistent.

It does **not** hold:

- `/etc/supamac`. Keep a copy of `generated.env` somewhere safe: without it
  a restored instance cannot decrypt stored credentials or verify sessions.
- Object metadata. A restored object is served with the content type its
  key's extension stands for, and as `application/octet-stream` when the key
  has none, which is every static file: the attachments of documents, mail
  and chat. Cache settings and custom metadata are gone.

The backups are on the same disk as the data, and every one is a full copy:
with the default of 7 the disk has to hold the data about eight times over.
Nothing watches free space. A full disk stops Postgres and everything else
on the VPS, n8n included; lower `SUPAMAC_BACKUP_KEEP` before that. Copying
backups off the VPS is not part of this stack.

To restore:

1. Note the folder name from the `backup` container's log.
2. Stop the `supamac` project in the deploy tool. Its volumes stay.
3. Deploy `restore.compose.yaml` as its own project with
   `SUPAMAC_OPS_IMAGE` and `SUPAMAC_RESTORE_FROM=<folder name>`.
4. Wait for `restore of <folder name> complete` in the `restore`
   container's log, then remove that project.
5. Start the `supamac` project again by deploying it.

The volumes are named `supamac_...` whatever name the deploy tool gives the
project, and `restore.compose.yaml` mounts them by those names.

On a new VPS, put `/etc/supamac` back first, deploy the stack once so the
volumes exist, stop it, and continue at step 3; the backup folder has to be
in the `supamac_backups` volume, which this stack has no way to fill from
elsewhere.

## Upgrading

Deploy the stack again with the new image references. The jobs run first:
new migrations are applied before any service starts, and missing topics,
buckets and tables are created. A container that reads the config volume or
the KMS seed is recreated when `SUPAMAC_OPS_IMAGE` changes, which is why that
reference has to change with the image. A replaced container has a new
address, and the Rust services keep the address they resolved for up to ten
minutes, so Compose restarts each service whose store, FusionAuth or peer it
replaced (`restart: true` under `depends_on`). Without that, the rehearsal
saw sign-in answer 500 for ten minutes after a new ops image.

Restarting the project by hand (`docker compose restart`) brings the
long-running containers back in order and healthy. It also starts the
finished jobs again, at once and before the database answers, so four of
them end as failed. That is harmless: their work was done, and the next
deployment runs them again.

A FusionAuth kickstart change does not reach a running instance; see
[`ops/config/fusionauth/README.md`](ops/config/fusionauth/README.md).

## What the services image has to contain

`compose.yaml` starts each Rust service as `/app/bin/<binary>` from
`SUPAMAC_SERVICES_IMAGE`, built with default cargo features, and checks
health with `curl`:

- default: `authentication_service`, `connection_gateway_service`,
  `contacts_service`, `document_storage_service`,
  `document_upload_finalizer_local_worker`, `notification_service`,
  `static_file_service`, `unfurl_service`, `image_proxy_service`,
  `agent_harness_service`
- `email`: `email_service`, `pubsub_workers`, `calendar_service`,
  `email_refresh_handler`, `email_scheduled_handler`
- `search`: `search_processing_service`

The sync image keeps its state in `/app/.wrangler/state` and the AI editing
image in `/data`; the lexical image answers `GET /health` and has `bun`; the
search image is `infra/local/opensearch`. The Dockerfiles in `images/` say
the same from their side.

The ops image is built from the repository root:

```sh
docker build -f infra/self-hosted/ops/Dockerfile -t <ops image> .
```

## What was checked

### The rehearsal

Once, on a development machine with 4 CPUs and 16 GB: the five images built
from this repository, the bootstrap project run into a scratch directory, and
the default profile started from empty volumes. In front of the gateway a
Caddy container stood where Traefik stands, terminating TLS for
`api.<domain>` with the three response headers the labels ask for; the web
bundle, built for a folder and packaged with the enforced policy, was served
by Apache on a sibling hostname; the mail relay submitted to a mail catcher
over STARTTLS with a login. Observed:

- Every container reached healthy or completed in about a minute and a half:
  852 migrations, 28 topics, the buckets, tables, queues and keys, and
  FusionAuth's kickstart in production mode on Postgres 18.
- In headless Chromium: a code requested from the UI, read from the mail the
  stack sent, and accepted; cookies set `SameSite=Strict`, `Secure`,
  `HttpOnly`, for the API host only; onboarding, a team, a document typed
  into and read back after a reload, a file uploaded through a presigned link
  and finalised through the object store's event, the file opened again, a
  CRM company and contact, sign-out.
- An address outside the allow-list is refused with 403 and gets no mail;
  the code request answers `{}`; a second request within 30 seconds answers
  429; internal, webhook and documentation paths answer 404; a request from
  outside with the real internal key and a user id answers 401, where the
  same request inside the network answers 200.
- A new ops image replaced the containers that read its config and the
  services were restarted with them; `docker compose restart` of the whole
  project came back healthy with the account, the team, the document and the
  upload intact; two backups were written by the running stack.
- Idle memory, per container, from `docker stats`: 3.3 GB in all. The
  largest: the AI editing worker 630 MB, Postgres 575 MB, FusionAuth 500 MB,
  Kafka 420 MB, the sync service 400 MB.

Three defects of this directory were found and fixed by it: the services
sent bare queue names the queue service refuses, the agent harness exits
unless FusionAuth has an identity provider named `google_gmail`, and the AI
editing worker never listened inside its memory limit.

### Piece by piece

Before the rehearsal, on a development machine, without starting the stack.
Where a check needed a server, the server ran inside an image build step and
went away with it:

- `docker compose config` accepts `compose.yaml` (default profile, and with
  `email` and `search`), `bootstrap.compose.yaml` and `restore.compose.yaml`
  with the values of `example.env`.
- The bootstrap script was run against a scratch directory, with stand-ins
  for `apk` and `ssh-keygen`: it writes both files with mode 600, prints
  names only, and a second run changes nothing. A run after one that stopped
  half-way succeeds, and a generator that fails writes nothing and names the
  variable. Compose reads the resulting `generated.env` and hands the PEM
  values to a service as multi-line PEMs.
- The ops image builds. The build validates both Caddy files with the Caddy
  version the stack runs, runs the Bun tests (the upload relay, the queue
  call, the clock, the kickstart's variables), syntax-checks the scripts and
  runs each program it copies in.
- The database scripts were run against a temporary Postgres 18 inside a
  build step of a throwaway image on top of the ops image: `migrate.sh`
  applied all 852 migrations with the image's sqlx CLI and applied none on a
  second run; it refused a database with a table and no migration history;
  `init-fusionauth-db.sh` ran twice; `grant-owner-roles.sh` granted once to
  an account that existed and nothing to one that did not; `pg_dump` and
  `pg_restore`, as `backup.sh` and `restore.sh` call them, round-tripped both
  databases.
- `init-volumes.sh` was run against scratch directories: the KMS seed
  renders to valid YAML with five keys and aliases.
- `backup.sh` and `restore.sh` were run in a build step on top of the ops
  image, against a Postgres and the pinned object store started in that
  step: both databases, the objects' bytes and the four volumes came back
  with their owners, objects added after the backup were gone, a folder with
  a part missing was refused, retention kept the newest folders only, and
  the copy of a volume was repeated while it was written to. That run is
  also where the lost object metadata was seen.
- The object store's health check was run in the pinned image against a
  running and a stopped server, and the database's against a server that
  listens on its socket only.
- `init-kafka-topics.sh` was run in the pinned Kafka image against a broker
  started in a build step: 28 topics created, none on a second run, and the
  missing ones only from a list written on one line.
- The `add_secret` snippet writes values Compose reads back unchanged,
  including `$`, `#`, quotes and backslashes.
- The names of the service environment were compared with the local stack's:
  the differences are the ones this file and `compose.yaml` explain.

## Not covered, not verified

Nothing below has been observed working, unless it says what was observed.

**The stack as a whole**

- It has never run on a VPS, behind Traefik, on a real domain, or with a
  real SMTP provider. The `email` and `search` profiles have never been
  started, and `init-search-indices.sh` has only been syntax-checked.
- The images of the rehearsal were built on the development machine, with
  lines added to scratch copies of the Dockerfiles so the builds trust that
  machine's outbound proxy. The images the workflow publishes have not been
  run.
- Memory was measured idle, with two accounts and a handful of documents.
  Nothing was measured under load.
- After a reboot Docker restarts the containers itself, in no order. A
  service that comes up before its database exits and is restarted; the jobs
  do not run again until the next deployment. Not tried.
- No monitoring and no alerting. The logs are the only signal, 60 MB per
  container.

**The stand-ins for AWS**

- How ElasticMQ treats a queue added to its config after its database
  exists. The dead-letter queue's 14-day retention cannot be expressed in its
  config.
- That the KMS emulator enforces the encryption context the services bind
  ciphertexts with. No stored credential was created in the rehearsal.
- Attachment links of mail and chat through `/local-storage` and
  `/static-file`. A document's upload and download links were seen working.
- Lambda-only pipelines do not run: text extraction, `.docx` unpacking, the
  delete handlers and the retention sweeps. Deleted objects stay in the
  store.

**Sign-in**

- Signing out does not end the session on the server. The service expires
  the two cookies and calls FusionAuth's logout page, which revokes nothing:
  in the rehearsal a copy of the cookies taken before sign-out still
  answered as the user, and FusionAuth still exchanged its refresh token for
  a new access token. Refresh tokens live 30 days from their last use. The
  fix is in `services/authentication_service/src/api/logout.rs`.
- When the relay refuses a message, for instance because the recipient's
  domain does not exist, the code request still answers 200 and the person
  waits for a mail that never comes. The relay's log is the only trace.
- Whether FusionAuth checks the web client's redirect address against the
  exact-match list in the kickstart. Sign-in by code does not redirect.
- Google and Microsoft sign-in are not configured. The web client's "Continue
  with Google" leads to an error.
- Sign-in throttles are per address only. Someone who knows an address can
  use up its daily code requests. The gateway adds no limit of its own.
- FusionAuth's admin console is not reachable from outside, and no way to
  reach it is provided.

**The gateway**

- The routes of sign-in, documents, the CRM, uploads and the two sockets,
  and every deny rule, were exercised. `/email`, `/calendar`, `/ai-editing`,
  `/unfurl`, `/image-proxy` with a reachable target, `/mcp` and `/preview`
  were not.
- The web client also opens a socket at `/websocket`, a service this stack
  does not have. The gateway answers 404 and the client keeps trying.
- `/unfurl` needs no sign-in upstream and stays an open fetch proxy.
- It trusts `X-Forwarded-For` from private addresses, read from the right.
  That is correct if Traefik is the only caller.
- The response headers on object routes may break a preview that frames an
  object from another origin than the UI's.
- With the `email` profile, the Gmail push webhook is reachable under
  `/email`; how it authenticates a push was not checked.

**Features**

- The AI assistant was opened with no provider key and no route to a
  provider: the session shows "I ran into an error and stopped before
  finishing". It has not been seen answering.
- The document storage service asks a LiveKit server for its rooms about
  once a minute. There is none, so each try logs two errors.
- The sync service and the AI editing worker run under `wrangler dev`, which
  asks a Cloudflare host for request metadata when it starts and carries on
  without an answer.
- Without the `email` profile the web client's calls to `/email` and
  `/calendar` fail in the browser console on every page load, and the
  onboarding step for a mail account shows "Couldn't load your connected
  accounts".
- A new account, the owner's included, is shown the upstream plans during
  onboarding, because `grant-owner-roles` runs at the next deployment.
- Without the `search` profile the document storage service is given a
  stand-in that answers its startup probe; search requests fail.
- Feature flags are read from PostHog, which is deliberately unreachable, so
  flag-gated features stay off; some CRM writes refuse without their flag.
  Creating a company and a contact did not.
- The agent harness has no sandbox provider. Sessions that need one fail. It
  reaches its own MCP and preview routes through the public address, which
  requires the VPS to reach itself that way.
- The email schedules use a small runtime API written for this stack in
  place of AWS's emulator, whose binary could not be fetched and pinned from
  the development machine. The two handlers have not been run against it.
- The calendar reminder sweep is not ticked, and calendar search stays off.
- No Stripe: the sign-up sentinel skips it, and billing screens may show
  inconsistent state for accounts given roles by `grant-owner-roles`.
- The Passwords vault (OpenBao) is not part of the stack.
- Links the services build to the web app may still assume the upstream
  folder `/app`.

**Data**

- Backups stay on the VPS, and nothing stops them filling its disk. Restore
  has been run in a build step, never on a started stack.
- The state volumes are copied while in use. A copy is only accepted as
  quiet by the files' sizes and write times; the sync service's and DynamoDB
  Local's own files have not been copied and opened again.
- A restore does not bring back object metadata; see
  [Backup and restore](#backup-and-restore).
- Redis, Kafka, the queues and the AI editing worker's state are not backed
  up.
- Every service connects to Postgres as the database owner. OpenSearch has no
  authentication; it is on the internal network only. Traffic between
  containers is not encrypted.
- Every container built by the fork receives all of `generated.env`.
