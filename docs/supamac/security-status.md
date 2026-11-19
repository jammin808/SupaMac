# Security and verification status

Initial assessment: 2026-11-19. Imported upstream revision:
`f8a38d2b114fab2e35563684b3b4e2ef33a39b58`.

**Release status: blocked.** These are full-source inherited findings, not a
clean security assessment. Adding scanners does not certify the application.
No production infrastructure has been deployed or modified.

## Live dependency scans

Bun 1.4.5 scanned every independent tracked JavaScript lockfile (preferring Bun
where a directory also has an npm lock). The older upstream Bun 1.3.13 cannot
read the agent-template version-2 lockfile; the fork CI pins a compatible scanner.
High/critical counts below are scanner matches per lockfile, not unique CVEs;
workspaces can share the same vulnerable dependency.

| Lockfile root | High | Critical |
| --- | ---: | ---: |
| Main workspace | 28 | 15 |
| `apps/docs` | 77 | 2 |
| `infra` | 14 | 0 |
| `packages/starter-agent` | 0 | 0 |
| `services/analytics-proxy` | 14 | 0 |
| `services/cla-worker` | 8 | 0 |
| `services/sync-service` | 20 | 0 |
| `tooling/scripts/migrate-s3-keys-extensionless` | 1 | 0 |

Six other independent lockfile roots had no high/critical matches. Lower-severity
findings remain relevant and are not a declaration of exploitability or safety.
Refresh with `bun run supamac:audit`; a scanner/network/format failure is fatal,
not a clean scan.

The initial main-workspace scan found 73 high and 17 critical matches. Compatible
patches updated 25 packages, including DOMPurify, Handlebars, Axios, Hono and Zod.
The independent agent lockfile is synchronized with its updated manifest.
No scanner exceptions were added; remaining advisories still fail the gate.
The editor/email parser suite passed 646 tests and the code-mode SDK passed 13.
The agent security suite passed all 88 tests after installing SOPS 3.13.3 and age
1.3.2 from official releases verified against their published SHA-256 digests.
This includes real encrypted credential round-trips and wrong-key rejection.
The SDK build and agent/code-mode typechecks also passed.
The complete agent-library and starter-agent suites then passed **158** and
**636** tests, respectively, with native Chromium access. They exercise real
browser interaction, screenshots and clipboard-based secret entry; the command
sandbox had blocked Chromium startup in the first full-suite run.

RustSec `cargo-audit` 0.23.0 against the current advisory database initially found **21
vulnerability entries**, plus 1 notice, 12 unmaintained, 36 unsound and 3 yanked
warnings. Affected packages include `h2`, `lettre`, `postgres-protocol`,
`quinn-proto`, `quinn-udp`, `libsqlite3-sys`, `libz-sys`, `crypto-bigint` and `rsa`.
The fork scan does not inherit the upstream `deny.toml` advisory exceptions.

Compatible lockfile updates to `lettre`, `libz-sys`, `postgres-protocol`,
`quinn-proto` and `quinn-udp` reduced RustSec vulnerability entries to **4**:
`crypto-bigint`, `h2`, `libsqlite3-sys` and `rsa`. Warning categories remain
release-review work. These updates still need application-level Rust compilation
and tests on a host with enough build storage.

Current release metadata confirms that some remaining fixes require major-version
migrations and some affected packages have no newer published release. Forcing global major
overrides would not establish application compatibility. Remediate by dependency
owner, check reachability and affected features, update compatible versions first,
and test each required migration. Do not treat this report as a waiver.

## Secrets scan

Gitleaks 8.30.1 scanned the working source with redaction and reported **170
matches** in imported code/configuration/test material. Many are under protocol
test fixtures and development infrastructure; each still requires classification
before production. No match was automatically allowlisted to clear the gate.
Only installed dependencies, build artifacts and Git internals are excluded.
The scan does not validate whether an inherited credential is live. Do not copy
raw reports into public issues; retain redacted output only.

## Analysis and runtime limits

Fork workflow-generator tests, Clippy, Rustfmt, generated-workflow drift checks,
Actionlint, strict TypeScript checks on fork tooling, and its Bun tests are run
locally. Existing render-queue tests exercise deferred work, coalescing, priority,
cancellation and disposal. The final handoff records their actual results.

Hosted workflow-tooling checks and JavaScript/TypeScript CodeQL completed
successfully on the initial import. Both initial Rust CodeQL jobs exceeded the
45-minute limit during source extraction, so Rust analysis remains incomplete.
Their logs also contain SQLx macro-expansion warnings. The revised workflow uses
the tracked offline SQLx metadata for static analysis and allows up to 120 minutes
for Rust, retaining 45 minutes for JavaScript/TypeScript. The revised Rust run
also failed: its check annotation reports that the hosted runner lost
communication with GitHub. Full logs were unavailable, so the cause is not
confirmed. CodeQL now has a 4 GiB memory budget and two analysis threads, with
Cargo limited to two build jobs in static analysis, to leave runner headroom.
A successful Rust analysis remains a release requirement.

Feature branches run through pull-request CI only. Push CI runs on `main`,
avoiding duplicate full scans for the same pull-request update. Scheduled and
manually requested analysis remain available. Source and advisory scans continue
to report the inherited release blockers above.

Nix dependency checks build and forcibly rebuild the JavaScript dependency output
on Linux and macOS ARM, plus the agent's separate dependency output on Linux.
The Linux agent check also builds the assembled runtime and SDK. These checks use
standard GitHub-hosted runners, the tracked flake lock and no deployment credentials.
Dependency-lock changes must carry the measured fixed-output hashes; a cached old
output alone cannot establish reproducibility. The hosted Linux agent dependency
build, forced rebuild and assembled runtime/SDK build passed. Both main-workspace
hashes were measured from completed builds on Linux and macOS ARM and recorded.
CI verifies the recorded outputs with forced rebuilds on each pull-request update;
the matching workflow run supplies the current result.
The main workspace required lockfile hoisting normalization for Nix's pinned
Bun 1.3.13; isolated Linux/macOS input checks pass with both Bun versions and the
normalized lockfile retains the same live advisory counts.

This container lacks Nix and access to a Docker daemon. Full frontend typechecking
also exceeded the container's available memory. A full Rust service build, live
stack/browser flows and live OpenAI requests have therefore **not been verified**.
Run the upstream build/test commands on a suitably sized isolated Linux host;
passing the fork-tooling suite does not replace application verification.

## Production acceptance

Close or explicitly assess every inherited vulnerability/secret finding; run the
full frontend and Rust checks/tests and an end-to-end stack smoke test; verify
live model responses and tool authorization; replace development secrets/auth/
CORS and isolate service ports; exercise provider failures, cancellation,
reconnection and backup restoration. Preserve the AGPL source-offer obligations
for modified network deployments. See [self-hosting](self-hosting.md).
