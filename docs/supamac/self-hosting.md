# Self-hosting SupaMac

## Supported starting point

The complete upstream local stack is retained. It runs PostgreSQL, Redis,
LocalStack, OpenSearch, Kafka, FusionAuth, the Rust services, sync/lexical workers,
and the SolidJS frontend. It does not require an upstream account or Doppler.
The authoritative command and recovery documentation is
[Running locally](../development/running-locally.md).

Start from Linux with Nix and Docker. Run `nix develop`, then `just doctor-local`.
Use `bun run supamac:doctor` for an additional credential-presence and host check.
The first build is substantial: upstream documents roughly 7 GB per cached Rust
dependency set, in addition to Nix, images, sources and data. Leave ample space;
a small ephemeral development container is not a deployment host.

```sh
just run_local --no-doppler
```

Open the frontend URL printed on success. On the default instance the HTTPS proxy
uses port 8090 and Mailpit uses 8025. Trust the development CA only on your own
development machine, following `infra/local/certs/README.md`.

## Real AI

Use the native provider implementation, authenticated workspace tools, and the
existing agent lifecycle. `OPENAI_API_KEY` is a **server-side** secret. Do not add
it to `VITE_*`, any browser bundle, committed files, GitHub issues, or logs.

A secret manager may inject the credential into the process environment. For an
ignored `.env.local`, pass it explicitly; Nix/just do not automatically load it:

```sh
chmod 600 .env.local
just run_local --no-doppler --env-file .env.local
```

Keep the file off source control (`git check-ignore .env.local` should succeed).
Use a restricted project key, configure project budget alerts, and rotate it when
exposed. Check the name/presence only when diagnosing secrets.

There are two separate upstream mechanisms:

- Deployment provider keys fund normal model calls, model-backed tools, and
  summaries. `OPENAI_API_KEY` supplies the native OpenAI client; other provider
  keys are needed for features routed to those providers.
- Per-agent provider keys are encrypted at rest through the existing KMS-backed
  path. They require the upstream Premium/Max/team entitlement and do not fund
  every auxiliary model call. See
  [agent API keys](../agent-guide/ai-chat.md#agent-api-keys).

The upstream free-tier model is Gemini Flash. Without a Gemini credential the
local stack intentionally starts a **scripted model emulator**, which is not AI.
For live OpenAI, configure a permitted OpenAI model on the agent under
Settings → Agents, with the appropriate local plan/entitlement fixture; keep
authorization and metering enabled. Do not globally bypass billing/permission
checks to enable a self-hosted model. See the upstream
[quota runbook](../runbooks/ai-quota-enforcement.md) for local billing fixtures.
Use the models actually advertised by the runtime and available to the project;
do not assume every upstream model identifier is available to your account.

## Data and recovery

Use `just run_local --detach --instance <name>` to recover an existing instance
over its volumes. Avoid `down -v`, `reset_local`, `destroy_local`, and fresh/reset
flags when preserving data. Back up PostgreSQL, object storage, secrets and
sync-worker state; test restoration before relying on the deployment.

Missing OAuth credentials start the local Gmail/Outlook emulators. Real mail,
calendar, calling, payments and managed-agent integrations require their own
provider configuration. A copied repository cannot provision those accounts.

## Production deployment

The local stack is a development environment: fixed test secrets, development
auth, emulators, broad development CORS, and exposed helper ports are intentional.
Do not publish it directly to the internet.

The complete infrastructure is in `infra/` and worker configuration in
`services/`. Read [Infrastructure](../development/infrastructure.md) before
adapting it. Upstream stack references, resource IDs, service domains and IAM
trusts point to upstream-owned resources. Replace those for your own cloud
account, domain and secrets; retaining source is not a working production account.

Before production, close security findings, build and test the full stack on a
suitable host, configure authenticated HTTPS ingress, restrict database/cache/
broker and helper ports to private networks, replace development secrets and
auth configuration, and exercise backup/restore and agent failure recovery.
Keep agent tool execution isolated and scoped to the initiating user's authority.
No infrastructure deployment or database reset is part of this source import.
