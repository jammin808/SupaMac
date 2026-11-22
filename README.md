# SupaMac

A full, self-hostable source fork of [Macro](https://github.com/macro-inc/macro):
a SolidJS workspace with Rust services for documents, tasks, messages, email,
search, calendars, CRM, files, and AI agents. This repository includes the
backend, migrations, Docker development stack, Nix tooling, and Pulumi/Cloudflare
infrastructure, rather than a frontend connected to Macro's hosted accounts.

The imported source is pinned to
[`5eda62e0428f8815ba50f17bb2d86ac208256c76`](https://github.com/macro-inc/macro/commit/5eda62e0428f8815ba50f17bb2d86ac208256c76).
Original notices and the [AGPL-3.0 license](LICENSE.txt) are preserved. SupaMac is
an independent fork; upstream branding and service integrations remain in the
application. See the [original README](https://github.com/macro-inc/macro/blob/5eda62e0428f8815ba50f17bb2d86ac208256c76/README.md)
for the feature tour; it is also preserved in the import commit's history.

## Start locally

Use a Linux machine with Nix (flakes enabled), Docker, and enough RAM and disk for
a large Rust/Nix build. The current development container cannot run this entire
stack. The full local stack uses development secrets and emulators; keep it on a
trusted machine/network.

```sh
git clone https://github.com/jammin808/SupaMac.git
cd SupaMac
nix develop
just doctor-local
just run_local --no-doppler
```

Use the frontend URL printed by the stack. Passwordless login codes arrive in
the local Mailpit UI. See [the SupaMac self-hosting guide](docs/supamac/self-hosting.md)
for configuration, credentials, data persistence, and production requirements.

## AI at the core

Agents share the workspace's permission checks, linked context, tools, persistent
sessions, streaming, and usage metering. Native OpenAI Responses integration is
already implemented in `crates/agent`; no separate chat wrapper is needed.

Supply provider credentials only through the server's secret store or an ignored
env file passed to the stack. A real OpenAI key alone does **not** change the
upstream free-tier Gemini default or remove model entitlements. The guide explains
the distinction and how to select an OpenAI agent. Missing credentials and
emulators must not be mistaken for successful live AI verification.

## Checks and security status

```sh
bun install --frozen-lockfile --ignore-scripts
bun run supamac:doctor
bun run supamac:audit # requires Bun 1.4.5 for every imported lockfile format
bun test tooling/supamac
cargo test --locked -p xtask_workflows -p gh_workflow
cargo clippy --locked -p xtask_workflows -p gh_workflow -- -D warnings
cargo x workflows --check
```

[SupaMac CI](.github/workflows/supamac-ci.yml) runs fork-tooling checks,
JavaScript and Rust vulnerability audits, a redacted secrets scan, and CodeQL
security analysis for JavaScript/TypeScript and Rust on GitHub-hosted runners.
Upstream deployment/release/notification jobs are guarded to run only in the
upstream repository. Their source is retained for infrastructure adaptation.

**This import is not production-cleared.** Live dependency scans found inherited
high/critical advisories. Security checks deliberately fail on those findings.
Read [the security status](docs/supamac/security-status.md) before deployment.
The upstream SOC 2/ISO claims do not certify this fork or your deployment.

The [architecture review](docs/supamac/architecture.md) records the stability and
efficiency approach, including game-engine techniques that fit this application.
