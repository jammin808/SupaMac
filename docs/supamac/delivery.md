# Building what a SupaMac instance runs

Two workflows build everything a deployment needs, on GitHub-hosted runners
with the run's own token: the backend images and the web bundle. They deploy
nothing. Deploying is the operator's step, described in
[deployment](deployment.md) and
[`infra/self-hosted/README.md`](../../infra/self-hosted/README.md).

| Workflow | Builds | Publishes to |
| --- | --- | --- |
| `supamac-images.yml` | six container images | GitHub Container Registry |
| `supamac-web.yml` | the web bundle, packaged for static hosting | the branch `supamac-web-dist` |

**Nothing on this page has run on GitHub.** The workflows were written and
checked on a development machine. [Not yet verified](#not-yet-verified) lists
what the first runs have to show.

## What runs when

| Event | `supamac-images.yml` | `supamac-web.yml` |
| --- | --- | --- |
| Pull request to `main` that changes an input of the build | builds every image, pushes nothing | builds, tests and packages; uploads the folder as an artifact; publishes nothing |
| Push to `main` | builds and pushes every image | the same, then publishes the folder |
| Manual run | builds and pushes; `latest` moves only from `main` | as a push; it publishes only when started from `main` |

A pull request starts a workflow only when it touches a path that workflow's
source lists (`pull_request()` in `supamac_images.rs` and `supamac_web.rs`).
Pushes to `main` are not filtered.

Runs of one workflow on one ref never overlap. A newer pull request run
cancels the older one. On `main` a run in progress finishes, and of the pushes
that arrive meanwhile GitHub keeps only the newest waiting; a commit that was
replaced while it waited gets no image under its own SHA.

A manual run needs the workflow file on `main`. A pull request from another
repository gets a read-only token and no repository variables.

## Images

Each image is `ghcr.io/<owner>/<name>`, with the owner's name in lower case.

| Image | Built from | Holds |
| --- | --- | --- |
| `supamac-services` | `infra/self-hosted/images/services.Dockerfile`, over binaries compiled on the runner | every Rust service, one binary each under `/app/bin` |
| `supamac-sync` | `docker/sync-service.Dockerfile` | the sync service, a Cloudflare Worker under `wrangler dev` |
| `supamac-lexical` | `infra/self-hosted/images/lexical-service.Dockerfile` | the lexical service as one Bun bundle |
| `supamac-ai-editing` | `infra/self-hosted/images/ai-editing-worker.Dockerfile` | the AI editing worker with its sources, under `wrangler dev` |
| `supamac-ops` | `infra/self-hosted/ops/Dockerfile` | the stack's config, scripts, the sqlx CLI and the migrations |
| `supamac-search` | `infra/local/opensearch/Dockerfile` | OpenSearch with the one plugin the index mappings need |

The names follow the variables `compose.yaml` reads:
`SUPAMAC_SYNC_IMAGE` takes `supamac-sync`.

Every pushed image has:

- the tag of the full commit SHA, and `latest` when the run is on `main`;
- the labels `org.opencontainers.image.source`, `.revision` and `.licenses`
  (`AGPL-3.0-only`; `Apache-2.0` for `supamac-search`, which holds OpenSearch
  and none of this repository's code);
- BuildKit's provenance (`mode=max`) and SBOM, stored beside it in the
  registry;
- a signed provenance attestation of the pushed digest
  (`actions/attest-build-provenance`);
- its digest in the job summary of the run.

The SBOM lists what BuildKit's scanner finds in the image: operating system
packages and package manager metadata. It does not list the Rust crates
compiled into the service binaries; `Cargo.lock` at the labelled revision
does.

All images are `linux/amd64`. The PDF library the search service loads exists
for that architecture only.

### Pinning a deployment

`latest` and a commit tag can both be pushed again. A digest cannot. Take each
digest from the summary of the run that built the commit you deploy, where it
is printed as

```text
ghcr.io/<owner>/supamac-services@sha256:<digest>
```

and give that whole reference to the stack as `SUPAMAC_SERVICES_IMAGE`
(likewise `SUPAMAC_OPS_IMAGE`, `SUPAMAC_SYNC_IMAGE`, `SUPAMAC_LEXICAL_IMAGE`,
`SUPAMAC_AI_EDITING_IMAGE` and, with the `search` profile,
`SUPAMAC_SEARCH_IMAGE`). Use the six digests of one run: the images of one
commit belong together, and a new ops image is what makes the containers that
read its config restart.

Take them from a run in which every job passed. Four jobs push, and none
waits for another: the services image, the sync image, the lexical and AI
editing images, and the ops and search images. When one fails, most likely
the long services build, the others still move `latest`, which then names
images of different commits: a new ops image, with its migrations, beside the
services of an earlier commit. Do not deploy `latest` after such a run; run
the workflow again first.

The first push creates each package as private. The server pulls without
credentials, so make each of the six packages public once, in the package's
settings on GitHub. The images hold no secret: every credential reaches a
container at run time, from the server.

### The services image

The Rust services are compiled on the runner, not inside Docker: the root
`.dockerignore` leaves out `/packages`, which two build scripts read, and one
cargo invocation compiles the crates the services share once.

- One `cargo build --release --locked` names every package and binary, with
  **default features only**. A feature named there would be unified into every
  binary of the invocation, and the local stack's features let a request name
  its own user, return sign-in codes in responses and lift rate limits. A test
  fails if the command gains a feature flag.
- The binaries are the ones `infra/self-hosted/compose.yaml` starts as
  `/app/bin/<binary>`. A test holds the two lists equal.
- Cargo runs two compilers at a time (`CARGO_BUILD_JOBS`), with SQLx reading
  the tracked query metadata (`SQLX_OFFLINE`).
- The crate downloads and the release build are cached with `actions/cache`.
  Every run restores; only a run on `main` saves, so a pull request cannot
  change what a publishing run starts from. A fresh checkout's sources are
  newer than any cached build, so cargo recompiles the workspace's own crates
  on every run and reuses the third-party ones. A build that fails or runs out
  of time on `main` still saves what it compiled, and the next run continues.
- The job then builds the image locally and runs it with no network: each
  binary must find its shared libraries, the PDF library must load, and Deno
  and `git http-backend` must be present.
- The compiling job holds no registry permission. It hands the stripped
  binaries to a second job as an artifact kept one day; that job builds the
  same Dockerfile again and pushes.

The image runs as uid and gid 10001 and writes only below `/data/agent-git`.

### The other images

Each of the other images is built by its Dockerfile alone. A pull request
builds them in jobs with no registry permission; any other run builds and
pushes them in separate jobs that a pull request never starts.

The lexical, AI editing and ops images are built from the repository root.
Each has an ignore file named after its Dockerfile
(`lexical-service.Dockerfile.dockerignore`), which BuildKit reads in place of
the root `.dockerignore`. It admits only the paths the image is built from.

- `supamac-lexical` runs as uid 1000, listens on 8096 and answers
  `GET /health`. It keeps no state.
- `supamac-ai-editing` runs as uid 1000, listens on 8933 and keeps its state
  under `/data`. Its entrypoint,
  `infra/self-hosted/images/ai-editing-worker-entrypoint.sh`, lists the
  environment it reads.
- `supamac-sync` keeps its state, which includes document content, under
  `/app/.wrangler/state`.

## Web bundle

### Repository variables

Set under Settings, Secrets and variables, Actions, Variables. They are not
secrets: both required values are readable in the published bundle.

| Variable | Value | Required |
| --- | --- | --- |
| `SUPAMAC_WEB_BASE_PATH` | The folder the bundle is served from, such as `/workspace`. The stack's `SUPAMAC_UI_PATH`. | yes |
| `SUPAMAC_BACKEND_ORIGIN` | The backend's https origin, such as `https://api.example.com`: in lower case, with no path and without `:443`. `https://` followed by the stack's `SUPAMAC_API_HOST`. | yes |
| `SUPAMAC_WEB_ENFORCE_CSP` | `true` sends the Content Security Policy enforced. Anything else: report-only. | no |
| `SUPAMAC_WEB_OMIT_VIDEOS` | `true` leaves out the tutorial videos, about 105 MB. | no |

When a required variable is missing:

- a pull request builds for `/workspace` and `https://api.example.com`, so
  the build is still exercised. It publishes nothing;
- any other run fails in its first step, before it builds, and names the
  variables to set. No bundle built for the placeholders can reach the
  publishing job, which also compares the folder it is given with the
  variables and refuses a mismatch.

A value the web build would refuse fails every run in that first step, a
pull request's too.

Start with the policy report-only, as
[static publishing](static-publishing.md#from-report-only-to-enforced)
describes, and set `SUPAMAC_WEB_ENFORCE_CSP` afterwards.

### What a run does

1. Installs the locked JavaScript dependencies without install scripts, Rust
   1.94.0 with the `wasm32-unknown-unknown` target, and `just`, `wasm-pack`,
   `wasm-bindgen` and `wasm-opt`, each checked against a pinned sha256.
   wasm-pack would otherwise download the last two itself, unchecked.
2. Builds the ten WebAssembly packages (`just build-wasm`).
3. Runs the unit tests of the code the two build inputs select: the service
   addresses, and the links built on and read against the base path. The
   tests set the inputs themselves and also cover the hosted and the local
   addresses, so this step runs without the two inputs in its environment.
4. Builds the bundle in production mode with `MACRO_APP_BASE_PATH` and
   `VITE_BACKEND_ORIGIN` set from the variables. Only this step and the next
   are given them.
5. Runs `bun run supamac:package-web`. The tool refuses a bundle built for
   another folder and one in which no script addresses the backend; such a
   bundle would call the upstream hosts and load their analytics. A refusal
   fails the run. This is the only check of where the bundle sends requests:
   nothing searches the scripts for upstream hosts
   ([not verified](#not-yet-verified)).
6. Uploads the packaged folder and its upload order as the artifact
   `supamac-web`, kept three days.

### The published branch

A run on `main` that is not a pull request then makes the packaged folder the
only commit of `supamac-web-dist`. The branch holds built files and nothing
else, which is what a host that deploys a folder from a branch needs.

- The commit is made in a repository of its own and force-pushed to that one
  branch. No other ref can change; a test runs the step against a local
  repository to hold that.
- The job that pushes is the only one with `contents: write`. It checks
  nothing out and runs no code of the build.
- Each publish replaces the branch's history. A rule that forbids force
  pushes to every branch stops it.
- A deploy from the branch replaces the folder as a whole. The upload order
  in [static publishing](static-publishing.md#publish-order) cannot be kept,
  and the previous build's hashed files are gone, so a tab that was open
  during the deploy reloads once when it asks for one of them.

To publish again without a new commit, for example after changing a
variable, start the workflow by hand on `main`.

## Changing the workflows

Both files are generated. Edit
`tooling/xtask/crates/xtask_workflows/src/workflows/supamac_images.rs` or
`supamac_web.rs`, or a script in the folder of the same name, then run
`cargo x workflows` from the repository root.

A workflow is the fork's own when its module name starts with `supamac_` and
its file name with `supamac-`. The generator restricts every other workflow to
the upstream repository, and refuses a fork-owned workflow that names a runner,
secret or registry only upstream has, uses an action that is not pinned to a
commit, asks for more than `contents: read` for the whole workflow, or has a
job without a time limit (`fork_policy.rs`).

What is pinned, and where to move it:

| Pin | Where |
| --- | --- |
| Actions, one commit each with its release | `tooling/xtask/crates/xtask_workflows/actions.lock`; then `cargo x workflows actions fetch` and `cargo x workflows` twice (the first run rewrites the bindings, the second the workflows) |
| `just`, `wasm-pack`, `wasm-bindgen`, binaryen: URL and sha256 | `supamac_web/install_wasm_tools.sh` |
| The PDF library's sha256 | `PDFIUM_SHA256` in `supamac_images.rs` |
| Rust, which must be the release `rust-toolchain.toml` names | `RUST_TOOLCHAIN` in `fork_steps.rs` |
| Base images of the fork's Dockerfiles, by digest | each Dockerfile under `infra/self-hosted/images/` |

A base image pinned by digest does not pick up its distribution's security
updates until the digest is moved.

wasm-pack uses the `wasm-bindgen` on its path only at the release `Cargo.lock`
names, and downloads its own otherwise. When the lockfile moves
`wasm-bindgen`, a generator test fails until the pin and its sha256 move too.

Checks, from the repository root:

```sh
cargo x workflows --check
cargo test --locked -p xtask_workflows -p gh_workflow
cargo clippy --locked -p xtask_workflows -p gh_workflow -- -D warnings
cargo fmt -p xtask_workflows -p gh_workflow -- --check
```

The tests run the embedded scripts, so they need `bash`, `git`, `jq` and
`sha256sum`.

## Not yet verified

Checked on a development machine:

- The generator's tests, which run the embedded scripts that decide what is
  published: the build inputs with and without the variables, the push of the
  packaged folder to a local repository, and the checksum lines.
- The unit test step, run with the environment the generated workflow gives
  it: 49 tests pass. With `VITE_BACKEND_ORIGIN` in the environment five of
  them fail, which is why the inputs reach only the build and the packaging;
  a test holds that.
- wasm-pack 0.15.1 built a small crate with the pinned `wasm-bindgen` on its
  path and downloaded nothing. The archive's sha256 is the one its release
  publishes.
- The web workflow's packaging and publishing scripts were run on a real
  bundle built for `/workspace` and `https://api.example.com`: 1728 files
  without the videos, pushed as one commit to a local repository.
- actionlint 1.7.12 reports nothing on the three fork workflows. It ran
  without shellcheck, so a script no test runs was only syntax-checked by
  bash.
- `supamac-lexical`, `supamac-ai-editing` and the services runtime image were
  built with Docker from these Dockerfiles. The first two needed one added
  line so the install trusted the machine's outbound proxy; the third was
  built over stand-in binaries. Inside a build step the lexical service
  answered `GET /health`, the AI editing worker applied its migrations under
  `/data` and answered a request, and the services image passed the check the
  workflow runs.
- Every action's commit SHA and every tool's sha256 were resolved from the
  projects' own releases on 2026-11-21, and each base image digest from
  Docker Hub.

Not verified:

- Either workflow on GitHub. No run exists, so nothing is known about
  expression errors GitHub alone reports, token permissions in practice, the
  artifact hand-over, pushes to the registry, the attestations, or the push to
  `supamac-web-dist`.
- The release build of the services. It was never completed on the
  development machine. A cold build is estimated at one to two hours; the
  build step may run five hours before it gives up. Peak memory at two
  compilers is not measured, and neither is how much disk the build needs
  beyond what removing the preinstalled SDKs frees.
- That the service binaries need no shared library the image lacks. The check
  in the workflow is what will tell.
- Whether the cargo cache fits the repository's cache quota and how long
  restoring and saving it takes. Nothing prunes it: a run whose `Cargo.lock`
  has no entry starts from another lockfile's and saves on top of it, so
  builds of crate versions the lockfile no longer names accumulate, and each
  failed build on `main` adds an entry of its own.
- `supamac-sync`, `supamac-ops` and `supamac-search` built by this workflow.
- `just build-wasm` on a hosted runner. It builds ten packages in parallel;
  its peak memory there is not measured.
- That the published bundle sends nothing to an upstream host. The packaging
  tool shows that a script addresses the backend, not that no script
  addresses anything else. The scripts of a bundle built here for
  `/workspace` and `https://api.example.com` still name `gateway.macro.com`,
  `us.i.posthog.com`, `status.macro.com`, `auth.macro.com` and
  `static-file-service.macro.com`. Whether a self-hosted bundle ever requests
  one of them was not traced. The Content Security Policy lists none of them,
  but it is report-only unless `SUPAMAC_WEB_ENFORCE_CSP` is `true`, and a
  report-only policy stops nothing.
- Any image running in the stack. Both Workers run on `wrangler dev`, a
  development server, which asks Cloudflare's and npm's hosts for request
  metadata and its own latest version when it starts. Whether it starts
  without outbound access was not tested.
- That the host deploys `supamac-web-dist` into the right folder, and its
  behaviour during a deploy.
