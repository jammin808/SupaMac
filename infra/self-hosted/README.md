# Self-hosted backend

The SupaMac backend as one Docker Compose project on one VPS, for one owner
and a few teammates, reached from the internet at `https://<api host>`, the
host name `SUPAMAC_API_HOST` names. The web UI is a static bundle served
somewhere else and is not part of this directory.

**Status: rehearsed once on a development machine, never deployed.** The
default profile was started from empty volumes behind a stand-in for Traefik,
and a person's path through it was driven in a browser: sign-in by mailed
code, a team, a document, an upload, a CRM company and contact, sign-out. What
was run is listed under [What was checked](#what-was-checked); what the
rehearsal could not show, and what it showed to be wrong outside this
directory, is under [Not covered, not verified](#not-covered-not-verified).
Read that list before relying on any part of this.

## What it assumes about the VPS

- Docker Engine 28 or later with Compose, driven through a tool that takes
  a Compose file and a list of environment variables and shows container
  logs. No shell is needed to deploy; the owner needs a root terminal once,
  to add third-party keys. Engine 28 is the first with the `isolated`
  gateway mode the networks without a route out use (their bridge gets no
  address, so their containers cannot reach anything listening on the VPS
  itself); it also has the fix for CVE-2024-29018, by which containers on
  such a network could send DNS queries out.
- A Traefik container that is already there, with the Docker provider and
  `exposedByDefault=false`, an entrypoint `websecure` on 443, a certificate
  resolver named `mytlschallenge`, attached to the Docker network
  `n8n_default`. Those three names are written into `compose.yaml`.
- 16 GB of memory shared with what already runs there. The limits of the
  default profile add up to 12.2 GB; idle, the rehearsal measured 3.3 GB in
  use. [Profiles](#profiles) says what fits beside it.

## How the pieces fit

```
 browser ── https://<ui origin>/<folder>/        static bundle, hosted elsewhere
    │
    │ https://<api host>/<service>/...
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

With the `jobs` profile, the jobs service sits on a third network, `jobs`,
which has no route out. Its only neighbours there are `jobs-gateway`, a
gateway of its own whose port 8081 serves it SupaMac's storage API as its
own account and nothing else, and `jobs-egress`, a CONNECT proxy that is
also on `egress` and opens tunnels to `api.anthropic.com:443`,
`api.telegram.org:443` and the jobs mailbox's host and port, and nowhere
else. A fourth network, `jobs-extract`, also without a route out, joins it
to `jobs-extract`, where its files are parsed with no secret and no state
at hand ([The jobs profile](#the-jobs-profile)).

### Files

| File | What it is |
| --- | --- |
| `bootstrap.compose.yaml` | One-shot project that creates the secrets on the VPS. |
| `compose.yaml` | The stack. |
| `restore.compose.yaml` | One-shot project that puts a backup back. |
| `example.env` | The variables the operator supplies, with placeholders. |
| `ops/` | The ops image: config files, scripts, the sqlx CLI with the migrations, the upload relay, the clock, the jobs egress proxy, and the jobs service (`ops/jobs`). |
| `images/` | Dockerfiles of the other images the fork builds for this stack. |

### Profiles

| Profile | Adds | Limits add |
| --- | --- | --- |
| default | Sign-in, documents, tasks, CRM and contacts, notifications, static files, upload finalizer, connection gateway, collaborative editing, the AI assistant, reminders, backups | 12.2 GB |
| `email` | Email service and workers, calendar service, the email schedules | 1.6 GB |
| `search` | OpenSearch and the search indexer | 2.3 GB |
| `jobs` | The jobs service, its extraction container, its gateway and its egress proxy: details of job invites, production packs and purchase orders ([`docs/supamac/jobs.md`](../../docs/supamac/jobs.md)) | 1.2 GB |

A limit is the most a container may use before the kernel stops it, not
memory set aside for it. The limits are estimates from the settings and the
code in the repository, with one exception: the rehearsal saw the AI editing
worker hold about 1 GB and never listen under the 512 MB it had, and raised
it. Three more were raised with the upstream snapshot of 2026-11-21, as
estimates, and are the first to measure when the stack is next rehearsed:

| Container | Was | Is | Why |
| --- | --- | --- | --- |
| `agent-harness-service` | 1536 MB | 2048 MB | It now type-checks every program an agent writes before running it: about 250 MB a check, up to four at once, beside the programs that are running. The limit is meant to hold the service, four checks and a handful of programs. The most the code allows, sixteen programs at their 128 MB heap target during four checks, is about 3 GB on top of the service itself; neither the old limit nor this one holds that. |
| `notification-service` | 256 MB | 384 MB | For a notification an agent sends, it checks what each recipient may see, with the document, mail, CRM and chat readers that takes. Upstream runs it with 512 MB in its smallest environment. |
| `search-processing-service` | 512 MB | 768 MB | It runs two sets of event workers, one for mail and one for everything else, where it ran one. Upstream runs it with 1024 MB in its smallest environment. |
| `ai-editing-worker` | 512 MB | 1280 MB | Measured: it bundles itself when it starts and holds about 1 GB; under 512 MB the bundler was killed and the worker never listened. |

What fits on a 16 GB server: the kernel, Docker with up to 35 containers,
Traefik and one other small application take, as a guess, 2 GB, which leaves
14 GB. If every container reached its limit at once, the default profile
with `email` would stay inside that (13.8 GB), the default profile with
`search` would be just over it (14.4 GB), and with both it would not
(16.0 GB). The `jobs` profile adds 1.2 GB: beside the default profile alone
it fits (13.4 GB), beside the default profile and `email` it is over
(15.0 GB). Its extraction container's limit, 640 MB, is an estimate that
leaves room for the parser to pass the 384 MB it is allowed before it is
stopped (`compose.yaml` says how each limit adds up). Idle, the default profile used 3.3 GB
in the rehearsal. No
limit was lowered to make more fit: nothing has been measured under load,
and the limits with most to give are the stores', where a stop for want of
memory costs most. Until there are measurements, running `search` on such a
server means that a spike in several containers at once can make the kernel
stop one, of this stack or of the other application.

The jobs have limits of their own, 1.5 GB together, which count only while
a deployment runs.

## First deployment

1. **Images.** The fork's GitHub Actions build and push the images to a
   public registry. Take their references; a reference must be immutable (a
   commit tag or a digest).
2. **Bootstrap.** Deploy `bootstrap.compose.yaml` as its own project, with no
   variables. Its log ends with the names of the variables it wrote to
   `/etc/supamac/generated.env`. Remove the project again. Deploying it a
   second time changes nothing.
3. **DNS.** Point `<api host>` at the VPS.
4. **The stack.** Deploy `compose.yaml` with the variables of
   [`example.env`](example.env). The jobs run first; the services start when
   the jobs are done. `mail-relay` keeps restarting until step 5: it refuses
   to run without a provider.
5. **Third-party keys.** Add the SMTP provider and any AI keys as described
   under [Adding third-party keys](#adding-third-party-keys), then deploy the
   stack again. Nobody can sign in before the mail relay runs, because the
   sign-in code arrives by mail.
6. **The web bundle.** Build and publish it for
   `https://<api host>`; see
   [`docs/supamac/static-publishing.md`](../../docs/supamac/static-publishing.md).
7. **First sign-in.** Sign in with an address from the allow-list. Then
   deploy the stack once more: `grant-owner-roles` gives the accounts in
   `SUPAMAC_OWNER_EMAILS` the paid-plan roles, which it can only do for
   accounts that exist.

Checks worth doing from outside the VPS afterwards:

- `POST https://<api host>/auth/login/passwordless` answers without a
  `code` field, and a second request for the same address within 30 seconds
  answers 429. Either failing means the services image was built with the
  developer features.
- `https://<api host>/auth/docs`, `/auth/internal/health`,
  `/auth/webhooks/user` and `/dss/items/soup/graphql` (GET) answer 404.
- No port other than Traefik's answers.

## What the operator supplies

In the deploy tool, with the Compose file. None of these is a secret.

| Variable | Meaning |
| --- | --- |
| `SUPAMAC_API_HOST` | The host name the API is served at, such as `api.example.com`: the API is `https://<this>`. It must share a registrable domain with `SUPAMAC_UI_ORIGIN` (`api.example.com` beside `https://example.com`), because session cookies are strict and set for this host only. Set it before the first start: the identity server's issuer and redirects are written from it once, on an empty database. |
| `SUPAMAC_DOMAIN` | Domain mail is sent from, unless `SUPAMAC_MAIL_DOMAIN` names another, and the domain of the identity server's admin account. |
| `SUPAMAC_UI_ORIGIN` | The origin browsers send, `https://example.com`, without path or trailing slash. Every service allows exactly this origin. |
| `SUPAMAC_UI_PATH` | The folder of the bundle below that origin, `/supamac`. The bundle is always built for a folder, never the site's root. |
| `SUPAMAC_SIGNUP_ALLOWLIST_JSON` | JSON array of the only addresses that can create an account, such as `["you@example.com"]`. An invited teammate must be on it too, and so must the jobs mailbox with the `jobs` profile. It reaches sign-in only through a deploy. |
| `SUPAMAC_OWNER_EMAILS` | Comma-separated accounts that get the paid-plan roles. Optional. |
| `SUPAMAC_MAIL_DOMAIN` | Domain mail is sent from, if not `SUPAMAC_DOMAIN`. The relay refuses any other sender domain. |
| `SUPAMAC_SERVICES_IMAGE`, `SUPAMAC_OPS_IMAGE`, `SUPAMAC_SYNC_IMAGE`, `SUPAMAC_LEXICAL_IMAGE`, `SUPAMAC_AI_EDITING_IMAGE` | Image references. |
| `COMPOSE_PROFILES` | `email`, `search`, `jobs`, comma-separated. Optional. With `email` and `search`, the limits add up to more than a 16 GB server that also runs another application has left; until they are measured, [Profiles](#profiles) says what that risks. |
| `SUPAMAC_SEARCH_IMAGE` | Needed with the `search` profile. |
| `SUPAMAC_JOBS_MAIL_HOST`, `SUPAMAC_JOBS_MAIL_PORT` | With the `jobs` profile: the jobs mailbox's IMAP host and port (default 993), such as `imap.gmail.com`. The egress proxy allows exactly this pair, so the jobs service reads it from here and not from `jobs.env`. Without a host the service reads no mail, and its Status row says `SUPAMAC_JOBS_MAIL_HOST is not set in the deploy tool`. |
| `SUPAMAC_BACKUP_KEEP` | Daily backups kept, default 7. |

On the VPS, in `/etc/supamac` (mode 700, files mode 600, owned by root):

| File | Written by | Holds |
| --- | --- | --- |
| `generated.env` | the bootstrap project, once | Every internal secret: database, Redis and object-store credentials, the shared internal service key, the session signing secret, FusionAuth's API key, client secret and admin password, the token key pair, webhook verification secrets, the KMS key material. Also stand-in values for the AI provider keys. |
| `secrets.env` | the owner | Third-party credentials. Its values win over `generated.env`. |
| `jobs.env` | the owner, with `add_secret jobs` | The jobs service's keys and settings ([`docs/supamac/jobs.md`](../../docs/supamac/jobs.md#settings)). Only the jobs service reads it, and it reads neither of the other two. Optional: the stack deploys without it, and a jobs service started without it exits naming the first missing setting. |

The deploy tool never reads these files; the containers do, through
`env_file`. A value that spans lines, such as a PEM key, is stored on one
line in double quotes with `\n` between its lines; Compose turns that back
into line breaks, so the service receives the PEM as it is.

## Adding third-party keys

Open the VPS's browser terminal and become root (`sudo -i`). Paste this once
per terminal session; it only defines `add_secret` and asks nothing yet.

```bash
add_secret() {
  local file name value
  case ${1:-} in
    secrets) file=/etc/supamac/secrets.env ;;
    jobs) file=/etc/supamac/jobs.env ;;
    *) echo 'Run add_secret secrets for the stack, or add_secret jobs for the jobs service.'; return 1 ;;
  esac
  read -rp 'Variable name: ' name
  if [[ ! $name =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo 'That is not a variable name.'
    return 1
  fi
  if [[ $file == */secrets.env && $name =~ ^JOBS_ ]]; then
    echo "${name} is a setting of the jobs service, which reads only jobs.env: run add_secret jobs."
    return 1
  fi
  if [[ $file == */jobs.env && $name =~ ^JOBS_MAIL_(HOST|PORT)$ ]]; then
    echo "The mailbox's host and port are deploy variables: set SUPAMAC_${name} in the deploy tool."
    return 1
  fi
  if [[ $file == */jobs.env && $name =~ ^(JOBS_(STATE_DIR|SUPAMAC_URL|EXTRACT_URL|WEB_APP_URL|HEALTH_PORT)|HTTPS?_PROXY|NO_PROXY)$ ]]; then
    echo "compose.yaml sets ${name} for the jobs service, so the file's value would not be read."
    return 1
  fi
  if [[ $file == */jobs.env && $name =~ ^JOBS_(OWNER_EMAIL|MAIL_USER|MAIL_ALLOWED_SENDERS|MAIL_AUTHSERV_ID|TIME_ZONE|MONTHLY_LIMIT_USD|AI_MODEL|AI_FALLBACKS|AI_FALLBACK_MODELS|AI_PRICES|TELEGRAM_OWNER_ID)$ ]]; then
    read -rp 'Value (not a secret, so it is shown): ' value
  else
    read -rsp 'Value (it is not shown): ' value
    echo
  fi
  if [[ -z $value || $value == *"'"* ]]; then
    echo 'The value is empty or contains a single quote, which the file cannot hold.'
    return 1
  fi
  (
    umask 077
    touch "$file"
    sed -i "/^${name}=/d" "$file"
    printf "%s='%s'\n" "$name" "$value" >> "$file"
  )
  echo "Saved ${name} in ${file}. Redeploy the project for it to take effect."
}
```

Then run `add_secret secrets` for each key of the stack, which goes to
`secrets.env`, or `add_secret jobs` for each setting of the jobs service,
which goes to `jobs.env` (made, mode 600, if it is missing), and answer the
prompts. A secret's value is not echoed; the jobs service's settings that are
not secret (its owner's address, allowed senders, authserv-id, time zone,
limit and the like) are shown as you type them, so a typo can be seen. A
value is written nowhere but the file. Entering a name a second time
replaces its value. A `JOBS_` name is refused for `secrets.env`, which every
other service reads, and the names `compose.yaml` sets are refused for
`jobs.env`. Then deploy the stack again.

To take out a line saved in the wrong file, run, with the name in place of
`NAME` and the file it is in:

```bash
sed -i '/^NAME=/d' /etc/supamac/secrets.env
```

and deploy again.

The stack's keys, with `add_secret secrets`:

| Variable | For |
| --- | --- |
| `RELAYHOST` | The SMTP provider, as `[smtp.example.com]:587`. Required. |
| `RELAYHOST_USERNAME`, `RELAYHOST_PASSWORD` | Its login. |
| `POSTFIX_smtp_tls_wrappermode` | `yes`, only for a provider on port 465. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini, the model every account may use. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CEREBRAS_API_KEY`, `FIREWORK_API_KEY`, `COHERE_API_KEY` | Further providers. A provider without a key fails when it is used. |

The provider must accept `no-reply@<mail domain>` as a sender, and the mail
domain needs the SPF and DKIM records the provider asks for.

## The jobs profile

The jobs service reads job invites, production packs and purchase orders
forwarded to a mailbox, sent to a Telegram bot or dropped in a SupaMac
folder, and keeps their details in a Jobs database in SupaMac.
[`docs/supamac/jobs.md`](../../docs/supamac/jobs.md) is its design, its
settings and its setup; this is how the stack runs it.

- **Four containers.** From the ops image: `jobs`, the service
  (`/opt/supamac/jobs`); `jobs-extract`, where its files are parsed
  (`ops/jobs/src/text/extract-server.ts`); and `jobs-egress`, its proxy
  (`ops/src/egress-proxy.ts`). Each runs as uid 65534 with a read-only
  root, no capabilities, no new privileges, a process limit and a health
  check. The image's base, Postgres's, declares a volume at
  `/var/lib/postgresql`; each mounts a small read-only tmpfs there, so
  Docker gives it no writable anonymous volume in its place. And
  `jobs-gateway`, a Caddy of its own (`ops/config/jobs-gateway/Caddyfile`).
- **Its own account, through its own door.** The service calls
  `http://jobs-gateway:8081/dss` with the API key of its own SupaMac
  account. That gateway, on the `jobs` and internal networks, listens on
  8081 alone and serves the storage API and GET of the object links that
  API hands out, behind the same deny rules as the public gateway, and
  nothing else. The stack's main gateway is not on the `jobs` network, so
  its `/unfurl` and `/image-proxy`, which fetch any address and would be a
  way past the egress gate, and its sign-in routes, whose throttles are per
  address, are out of reach of everything in the jobs containers. It takes
  no `X-Forwarded-For` from the service, so every service sees the jobs
  container's own address for its rate limits and audit. The service gets
  none of `generated.env` and `secrets.env`, and refuses to start if the
  internal service key or the database URL is in its environment.
  `ops/src/jobs-gateway.test.ts` holds the two gateways' deny rules to each
  other and the jobs networks to their members.
- **Its secrets and its parser.** Files are parsed in `jobs-extract`, which
  gets no env file and no volume, is on one network shared with `jobs`
  alone (`jobs-extract`, without a route out), and refuses to start with
  anything that looks like a secret in its environment. Each file is
  parsed in a child process that leads its own process group, killed with
  it, and after each file the server kills every other process in the
  container but its health checks. The service makes itself not dumpable,
  and parses nothing in its own container: a health check there, like any
  `docker exec`, carries the container's environment with every `jobs.env`
  secret, readable through `/proc` by any process of the same user, so no
  untrusted code may run there
  ([`docs/supamac/jobs.md`](../../docs/supamac/jobs.md#security)).
- **The egress gate.** `jobs` is on the `jobs` and `jobs-extract` networks,
  neither with a route out and, isolated, no address of the VPS either. On
  `jobs` only `jobs-gateway` (8081) and `jobs-egress` (3128) listen besides
  the service. HTTPS and the mailbox go through `jobs-egress`
  (`HTTPS_PROXY`; the jobs gateway and the extraction container, plain
  HTTP, are reached directly). The proxy opens a tunnel for
  `CONNECT` to `api.anthropic.com:443`, `api.telegram.org:443` and
  `SUPAMAC_JOBS_MAIL_HOST:SUPAMAC_JOBS_MAIL_PORT`, exactly, and answers 403 to
  anything else, an allowed name whose address is private, loopback or
  link-local included. It logs one line per request (host, port, outcome,
  bytes each way, never content) and holds no secret. At most 32 tunnels are
  open; one ends after 10 minutes without traffic or an hour in all.
- **Settings in three places.** Keys and the owner's choices in `jobs.env`
  (`add_secret jobs`). The mailbox's host and port in the deploy tool
  (`SUPAMAC_JOBS_MAIL_HOST`, `SUPAMAC_JOBS_MAIL_PORT`), because the proxy's
  allow-list is made from them. The wiring in `compose.yaml`:
  `JOBS_SUPAMAC_URL`, `JOBS_EXTRACT_URL`, `JOBS_WEB_APP_URL` (the UI's
  origin and folder), `JOBS_STATE_DIR`, `JOBS_HEALTH_PORT`, `HTTPS_PROXY`,
  `NO_PROXY`. A name `compose.yaml` sets wins over `jobs.env`, so none of
  those is read from it, and `add_secret jobs` refuses them.
- **State** in the volume `supamac_jobs_state`, which `init-volumes` hands
  to uid 65534 on every deployment and every backup copies. Only `jobs`
  mounts it.
- **Start and stop.** It starts once the storage service and the jobs
  gateway and extraction container are healthy: it exits if the Jobs
  database cannot be verified, or a setting does not validate, and the
  container is then started again and again (`restart: unless-stopped`)
  until the setting is fixed. A deploy that replaces it waits up to five
  minutes for an extraction in flight, whose reply streams for minutes; one
  still running then is cut, and its source is read again, and paid for
  again, at the next start.
- **Health.** The service's `/health` answers 503 while any of its loops
  (the ways in, the folder, edit and resume polls, the Status tick) has not
  succeeded for five of its intervals. Its body names each loop with its
  last success and error, and the service's log has a line for each run
  that failed; with SupaMac down the Status row cannot be written, so those
  are what say which. The container then shows as unhealthy; nothing
  depends on it.

To turn it on:

1. Do steps 1 and 2 of the design's [Setup](../../docs/supamac/jobs.md#setup):
   the mailbox with an app password, and the bot.
2. Give the service its own SupaMac account (Setup 3): in the deploy tool
   add the jobs mailbox's address to `SUPAMAC_SIGNUP_ALLOWLIST_JSON`,
   keeping your own (`["you@example.com","jobs@example.com"]`), and deploy;
   then, on a computer, sign out, sign in as the jobs mailbox, create an
   API key in Settings, API keys, and sign back in as yourself.
3. Save each setting the design's [Settings](../../docs/supamac/jobs.md#settings)
   lists with `add_secret jobs`: at least `JOBS_SUPAMAC_API_KEY`,
   `JOBS_OWNER_EMAIL` (exactly the address you sign in with),
   `ANTHROPIC_API_KEY` and `JOBS_MONTHLY_LIMIT_USD` (at least `20`), then
   those of each way in.
4. In the deploy tool, set `SUPAMAC_JOBS_MAIL_HOST` (and
   `SUPAMAC_JOBS_MAIL_PORT` unless it is 993), add `jobs` to
   `COMPOSE_PROFILES`, and deploy.
5. Go on with step 5 of the design's Setup: the **Jobs setup** document and
   the link code. If it has not appeared in the Job sources folder within
   about three minutes, open the `jobs` container's log in the deploy tool:
   the line `jobs service did not start` names the setting that stopped it
   (Setup 5 lists the usual ones), and the line `sharing the Jobs database
   and folders with the owner` names the address everything is shared
   with.

`jobs-egress`'s log shows every connection the service made or tried.

## Rotating a secret

`generated.env` is never rewritten by a tool. To rotate, change the value in
the file by hand, under every name it appears with, and deploy the stack
again; the comments in the file group the names. What follows from a change:

| Secret | Effect, and what else has to happen |
| --- | --- |
| Third-party keys | None. Use `add_secret secrets` (or `add_secret jobs` for the jobs service's). |
| `JOBS_SUPAMAC_API_KEY` (`jobs.env`) | On a computer, signed in as the jobs account, create a new key in SupaMac (Settings, API keys), save it with `add_secret jobs`, deploy, then delete the old key there. While the service runs, the sign-in code mailed to the jobs mailbox is refused like any mail from an unlisted sender: it is in the mailbox's `Refused` folder, and a Telegram note says so. |
| `ANTHROPIC_API_KEY` (`jobs.env`) | The jobs service's own Anthropic key: a new one from the Anthropic Console with `add_secret jobs`, deploy, then revoke the old one in the Console. |
| `JOBS_TELEGRAM_BOT_TOKEN` | Revoke the token in BotFather, which issues the bot a new one; save that with `add_secret jobs` and deploy. Until then the service cannot poll. |
| `JOBS_MAIL_PASSWORD` | A new app password at the mailbox provider with `add_secret jobs`, deploy, then revoke the old one at the provider. |
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
- `dynamodb.tar.gz`, `kms.tar.gz`, `sync-state.tar.gz`, `agent-git.tar.gz`,
  `jobs-state.tar.gz`: the five state volumes, copied while their services
  run. A copy is taken again, up to five times, until no file changed during
  it; the log has a `warning:` line for a volume that was never quiet, whose
  copy may then be inconsistent. The jobs state (the Telegram link, the
  pinned ids of the Jobs database, the saved model replies, what the checks
  know of each detail) is in no database; without the `jobs` profile its
  volume is empty and is copied all the same. `restore.sh` refuses a folder
  without any other part; one without `jobs-state.tar.gz` was written before
  the jobs service, and restores an empty jobs state with a line in the
  log saying so.

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

Deploy the stack again with the new image references, all built from one
commit. The jobs run first: new migrations are applied before any service
starts, missing topics, buckets, tables and queues are created, and every
queue's attributes are set. A container that reads the config volume or
the KMS seed is recreated when `SUPAMAC_OPS_IMAGE` changes, which is why that
reference has to change with the image. The order of an upgrade, and what
the snapshot of 2026-11-21 needs beyond it, is in
[`docs/supamac/deployment.md`](../../docs/supamac/deployment.md#upgrading).

The queue service keeps its queues in its data volume and creates only the
ones its config has and its database lacks; it does not change one that is
there. `init-aws` therefore sets each queue's visibility timeout, delay and
dead-letter queue on every deployment, and its log has one line per queue it
created and one per dead-letter queue with the number of messages in it.
Nothing else watches those three queues (`slack-import-dlq`, `contacts-dlq`,
`search-event-queue-dlq`) and nothing empties them: a message there was
received as often as its queue allows without being finished.

A replaced container has a new address, and the Rust services keep the
address they resolved for up to ten minutes, so Compose restarts each
service whose store, FusionAuth or peer it replaced (`restart: true` under
`depends_on`). Without that, the rehearsal saw sign-in answer 500 for ten
minutes after a new ops image.

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

The repository has held two upstream snapshots, of 2026-11-19 and of
2026-11-21. Each check below was run on the first unless it says otherwise;
[after the snapshot of 2026-11-21](#after-the-snapshot-of-2026-11-21) lists
what was run again, and nothing else was.

### The rehearsal

Once, on a development machine with 4 CPUs and 16 GB: the five images built
from this repository, the bootstrap project run into a scratch directory, and
the default profile started from empty volumes. In front of the gateway a
Caddy container stood where Traefik stands, terminating TLS for
`<api host>` with the three response headers the labels ask for; the web
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
  applied all 852 migrations of that snapshot with the image's sqlx CLI and
  applied none on a second run; it refused a database with a table and no migration history;
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
  started in a build step: the 28 topics of that snapshot created, none on a
  second run, and the missing ones only from a list written on one line.
- The `add_secret` snippet writes values Compose reads back unchanged,
  including `$`, `#`, quotes and backslashes.
- The names of the service environment were compared with the local stack's:
  the differences are the ones this file and `compose.yaml` explain.

Read from ElasticMQ's source at the pinned version 1.6.15, not tried: at
start it restores the queues in its database, then creates those of its
config whose names the database lacks, and takes nothing from the config for
a queue that is there; a change of visibility timeout, delay or dead-letter
queue made through its API is written to the database.

### After the snapshot of 2026-11-21

The snapshot carries 876 migrations and 29 event topics, and its local stack
has two more queues and other attributes on a third. Run on the merged tree,
on a development machine:

- `docker compose config` accepts `compose.yaml` with the values of
  `example.env`, by itself and with `email` and `search`. In the result every
  service that is given the stand-in PostHog key is also given the host
  nothing listens on, and the limits add up as [Profiles](#profiles) says.
- The Bun tests pass, and `sh -n` accepts every script. The tests now hold
  the queues of `elasticmq.conf` and of `init-aws.sh` to each other, and
  from a checkout also to the local stack's catalogue and to `compose.yaml`;
  run against the stack as it was before this update they fail on the two
  missing queues and the changed attribute.
- The tests run `init-aws.sh` against a stand-in for the AWS CLI that keeps
  a list of queues and records each call: on an empty queue service it
  creates the 31 queues and sets attributes on 6; where a queue exists with
  the defaults it is not created again and gets its attributes; a second run
  creates nothing; a refused call fails the job. The same was run by hand
  under `dash` and `bash --posix` against the 27 queues of the earlier
  config: 4 created.
- The topic list of the snapshot, read the way `init-kafka-topics.sh` reads
  it, gives 29 names, `macro.time_entries` among them.

Not run again: the ops image was not rebuilt, so the 876 migrations have not
been applied with its `migrate.sh` and no topic or queue has been created in
a broker or a queue service. The fork's image workflow builds the ops image
on every pull request that touches what it is built from, which runs the Bun
tests and validates both Caddy files; it applies no migration. In that build
the two tests that hold the stack's queues to the local stack's catalogue
and to `compose.yaml` are skipped, because the image has neither: they run
only where someone runs `bun test` from a checkout.

### The jobs service and its proxy

Run on a development machine; no container was started:

- `docker compose config` accepts `compose.yaml` with `jobs`, and as before
  without it and with `email` and `search`. With `jobs`, the proxy's
  allow-list holds the mailbox's pair when `SUPAMAC_JOBS_MAIL_HOST` is set
  and the two API hosts alone when it is not, `jobs.env` reaches the jobs
  service and nothing else, and neither jobs container is given
  `generated.env`.
- The proxy's tests (`ops/src/egress-proxy.test.ts`), over real sockets on
  127.0.0.1: bytes both ways, including those sent with the request head;
  other hosts, ports, methods and plain HTTP refused; an allowed name that
  resolves to a private address refused with nothing dialled; the cap on
  tunnels, the idle and total limits, a head too large or too slow; nothing
  of the payload or the headers in the log. Each refusal test fails when its
  check is taken out of the proxy.
- Bun's fetch, in versions 1.4.4 and 1.4.5, from a scratch script against
  the proxy and a local TLS server: with `HTTPS_PROXY` an HTTPS request goes
  through the proxy as `CONNECT <name>:<port>` and needs no DNS for the name;
  a host `NO_PROXY` covers, exactly or as a domain suffix, goes direct; an
  `http://` URL goes direct while `HTTP_PROXY` is unset, and with it is sent
  to the proxy as a plain request and refused.
- The jobs package's lockfile installs frozen with Bun 1.4.5 and not with
  1.3.5, the version the ops image's Bun stage had; the search helpers'
  lockfile installs frozen with 1.4.5 too, and the ops tests pass on it. The
  package's tests pass with 1.4.5 in a tree laid out as the image's build
  stage lays it out, without optional dependencies, and with them; the
  production install resolves every import of the service and its
  extraction worker, and the service started from it refuses to run without
  its key and with the database URL in its environment.
- The `add_secret` snippet writes both files with mode 600, makes `jobs.env`
  when it is missing, refuses for `jobs.env` the names `compose.yaml` sets,
  and writes values Compose reads back unchanged.

After a review of this wiring, on the same machine, again without starting
a container:

- `docker compose config` (Compose 5.7) accepts `compose.yaml` with each
  profile and gives both networks without a route out the `isolated`
  gateway mode, `jobs` a stop grace period of five minutes, a 640 MB limit,
  the storage service among what it waits for, and both jobs containers a
  tmpfs at `/var/lib/postgresql`.
- Caddy 2.11, built from source, validates both Caddy files. A copy of the
  gateway's file with its ports and upstreams moved to local stand-ins
  showed port 8081 sending the caller's own address as `X-Forwarded-For`
  whatever the request carried, where port 8080 passes on what a private
  caller wrote; serving `/dss` and GET under `/local-storage`, with the
  object store's Host; and answering 404 to `/unfurl`, `/auth`, a POST
  under `/local-storage`, the store's own API and the internal and
  documentation paths.
- The proxy's tests now also hold that a listed IPv6 literal opens a tunnel
  to that address without a lookup, and that a request answered 400 for a
  slow head is never routed, whatever follows it.
- As uid 65534 with no capabilities, as in the container: an extraction
  child of a service that has sealed itself cannot open the service's
  `/proc` environment or memory (`EACCES`), where without the seal it read
  a test secret from it; the sandbox's tests pass under the seal, and the
  service, sealed, starts as far as the gateway.
- A copy of `restore.sh` with stand-ins for the database and object store
  tools: a folder without `jobs-state.tar.gz` restores an empty jobs state
  and says so, one with it restores it, and one without another part is
  refused.

Not run: the ops image was not built with its new stage, and no jobs
container has started. The `jobs` network's isolation, the state volume's
ownership, both health checks, the memory and process limits, the stop
grace period, the seal inside the container, and IMAP through the proxy
have not been observed.

After a second review, which moved parsing and the jobs service's door into
containers of their own, on the same machine and again without starting a
container:

- `docker compose config` accepts `compose.yaml` with no profile, with
  `jobs`, and with `email,search`. With `jobs`, the `jobs` network holds
  `jobs`, `jobs-egress` and `jobs-gateway`; the `jobs-extract` network
  holds `jobs` and `jobs-extract` and is internal and isolated; the main
  gateway is on neither; `jobs-extract` has no env file and no volume
  (`ops/src/jobs-gateway.test.ts` holds these).
- The extraction server and the service's client of it, over a real socket
  on 127.0.0.1 with the real worker: a file parsed there equals one parsed
  in process; one extraction at a time, the sweep after each; a request
  that does not validate is refused unparsed; the container not answering
  is a retry, never a failed source; the server refuses to start with any
  variable that looks like a secret. The sweep was run against a stand-in
  `/proc` only: it kills every process but itself, PID 1 and those whose
  parent is outside the container. A child that starts a process and
  exits no longer leaves it running (the test fails without the group
  kill).
- The `add_secret` snippet, run against a scratch directory: with no
  argument it asks nothing; it refuses a `JOBS_` name for `secrets.env`,
  the mailbox's host and port for `jobs.env` (naming the deploy variable),
  and the names `compose.yaml` sets; it shows the jobs service's settings
  that are not secret as they are typed; both files are written mode 600.
- The jobs gateway's Caddyfile was not validated by Caddy here (no Caddy on
  the machine); the ops image's build validates it beside the other two.

Not run: none of the four jobs containers has started; the sweep and the
process limits inside the extraction container, and the jobs gateway, have
not been observed.

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
- `init-aws.sh` has been run against a stand-in for the AWS CLI and, on the
  snapshot of 2026-11-19, against the stack in the rehearsal; its queue
  changes for the snapshot of 2026-11-21 have only met the stand-in.
- After a reboot Docker restarts the containers itself, in no order. A
  service that comes up before its database exits and is restarted; the jobs
  do not run again until the next deployment. Not tried.
- No monitoring and no alerting. The logs are the only signal, 60 MB per
  container.
- The `jobs` profile has never been started; see
  [The jobs service and its proxy](#the-jobs-service-and-its-proxy). Its
  memory limits (320 MB for the service, 640 MB for the extraction
  container, 128 MB for the proxy, 64 MB for its gateway) are estimates.
- Every other container from the ops image also gets an anonymous volume
  at `/var/lib/postgresql`, which its base image declares. None of their
  scripts uses it, so the volumes only take a little disk. Read from the
  base image's Dockerfile, not observed.

**The stand-ins for AWS**

- The queues on a deployment that already has some. That ElasticMQ creates a
  queue added to its config after its database exists is read from its
  source, not seen. That it accepts `init-aws`'s calls through the router
  (list, create, set attributes), and that an attribute set that way is the
  one in effect afterwards, has not been seen either: `init-aws` fails the
  deployment if a call is refused, and does not read an attribute back. After
  the first deployment of this version, `aws sqs get-queue-attributes` for
  `email-service-refresh-queue`, run as `init-aws` runs the CLI, should show
  a visibility timeout of 300.
- Dead-letter queues keep a message until someone removes it: ElasticMQ has
  no retention period, so the 14 days of the deployed queues cannot be had.
  Moving messages back to their queue is not provided for.
- Only three queues have a dead-letter queue. On every other one, as on the
  local stack, a message its worker neither finishes nor deletes is delivered
  again without end.
- That the KMS emulator enforces the encryption context the services bind
  ciphertexts with. No stored credential was created in the rehearsal.
- Attachment links of mail and chat through `/local-storage` and
  `/static-file`. A document's upload and download links were seen working.
- Lambda-only pipelines do not run: text extraction, `.docx` unpacking, the
  delete handlers and the retention sweeps. Deleted objects stay in the
  store.

**Sign-in**

- Signing out revokes the session's refresh token at FusionAuth before the
  cookies are cleared (`services/authentication_service/src/api/logout.rs`),
  so a copy of them can no longer mint access tokens. An access token taken
  before sign-out stays valid until it expires, at most an hour: the
  services check its signature and expiry, not a revocation list. The
  rehearsal saw the gap this closes and ran before the change; the change is
  covered by unit tests, not yet by a run of the stack. Without a token in
  the request, or when FusionAuth cannot be reached, sign-out still clears
  the cookies and the span records `refresh_token_revoked`.
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
- `/unfurl` needs no sign-in upstream and stays an open fetch proxy. The
  jobs containers cannot reach it: the main gateway is not on their
  network.
- Port 8080 trusts `X-Forwarded-For` from private addresses, read from the
  right. That is correct if Traefik is the only caller there; any other
  container on Traefik's network could name the client address the
  services see. The jobs gateway, the jobs service's own door, trusts
  none.
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
  a feature that waits for its flag stays off; some CRM writes refuse
  without theirs (creating a company and a contact did not). Two features do not wait for a flag here. Upstream turns
  them on wherever `ENVIRONMENT=local`, which is how every service of this
  stack runs, and nothing in this stack turns them off:
  - **Agents can notify people.** Any account, an agent's or a person's,
    can send a notification of up to 280 characters with a link to an item
    (`POST /notification/user_notifications/send`, the SDK's
    `notifications.send`). Upstream's limits apply: the sender must be able
    to see the item, and so must each recipient, whose inbox must list items
    of its kind; at most 100 recipients a call; 1,000 notified recipients an
    hour for a sender; 60 an hour from others for a recipient. An agent
    session whose scope excludes sending is refused.
  - **Contact lists are written.** What tells the stack who a person's
    contacts are (mailbox sync, team changes, channel activity) is recorded
    in two new tables, `contact_list_members` and `contact_inbox_members`,
    beside the contact graph that has always been written. Nothing reads the
    new tables here: which of the two a person's contacts are read from is a
    per-person PostHog flag, and a read that fails means the old graph.
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
- No computer fleet for agent teammates. Two settings of the local stack
  exist only for one and are deliberately not set: `COMPUTERS_AGENT_EFFECTS`
  (absent means off; it starts the worker that takes agent teammates back
  from released computers) and `OVERRIDE_TELEMETRY_INTAKE_URL` (where a
  computer sends its traces; without it the address is the service's own
  loopback, which the services never hand to a computer).
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
- Every container built by the fork receives all of `generated.env`, except
  the jobs service, its extraction container and its egress proxy, which
  receive none of it.
