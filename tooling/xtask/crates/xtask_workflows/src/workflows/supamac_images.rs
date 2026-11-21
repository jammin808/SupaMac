//! The backend images a self-hosted instance pulls, built on GitHub-hosted
//! runners. A pull request builds every image and pushes nothing; a push to
//! `main` or a manual run pushes them to GHCR with the run's own token.
//! docs/supamac/delivery.md describes what is published and how it is pinned.

use anyhow::Result;
use gh_workflow::{
    Event, Expression, Job, Level, Permissions, PullRequest, Push, Run, Step, Use, Workflow,
    WorkflowDispatch,
};

use crate::workflows::{fork_steps, steps, yaml_fragment};

#[cfg(test)]
mod test;

// Resolved from each action's release tags on 2026-11-21.
const SETUP_BUILDX: &str = "f87e5991a6d7451dcb8d9637bfbc97413f497069"; // v4.4.1
const LOGIN: &str = "8aa5831fb8d48d8f76594c7ddde61ae58019f550"; // v4.8.0
const BUILD_PUSH: &str = "c3c9e263c25d99ce0380d002d59b67737d91b0dc"; // v7.4.0
const ATTEST_BUILD_PROVENANCE: &str = "4d101475d8b20a2381f78447822ac1eab6504dd8"; // v4.2.2

/// The Rust binaries of a self-hosted instance: each cargo package with the
/// binaries it puts in the image. They are the ones
/// `infra/self-hosted/compose.yaml` runs, which a test holds this list to.
/// `convert_service` and `document_text_extractor` are not here: the first
/// needs LibreOffice and an AWS Lambda beside it, the second is a Lambda the
/// stack has no stand-in for.
const SERVICE_BINARIES: [(&str, &[&str]); 15] = [
    ("authentication_service", &["authentication_service"]),
    ("document_storage_service", &["document_storage_service"]),
    ("connection_gateway", &["connection_gateway_service"]),
    ("notification_service", &["notification_service"]),
    ("static_file_service", &["static_file_service"]),
    (
        "document_upload_finalizer_handler",
        &["document_upload_finalizer_local_worker"],
    ),
    ("contacts_service", &["contacts_service"]),
    ("email_service", &["email_service", "pubsub_workers"]),
    ("email_refresh_handler", &["email_refresh_handler"]),
    ("email_scheduled_handler", &["email_scheduled_handler"]),
    ("calendar_service", &["calendar_service"]),
    ("agent_harness_service", &["agent_harness_service"]),
    ("search_processing_service", &["search_processing_service"]),
    ("unfurl_service", &["unfurl_service"]),
    ("image_proxy_service", &["image_proxy_service"]),
];

/// sha256 of `services/search_processing_service/pdfium-lib/linux/libpdfium.so`
/// as tracked. A test holds it to the file.
const PDFIUM_SHA256: &str = "3f3af4e4ba46bec9d0d11c5635262663b7020345ff4bed7eee85e883e2ce8455";

/// Where the services job puts what the services image is built from.
const SERVICES_CONTEXT: &str = "${{ runner.temp }}/services-context";

/// The services image's context as one file, which keeps the binaries' modes
/// between the job that compiles and the job that publishes.
const SERVICES_ARCHIVE: &str = "${{ runner.temp }}/services-context.tar.zst";

const SERVICES_ARTIFACT: &str = "supamac-services-context";

/// The image the services job builds to check it. Never pushed.
const SERVICES_CHECK_IMAGE: &str = "supamac-services:check";

/// The registry path of this repository's images, set by
/// [`name_registry_namespace`].
const IMAGE_NAMESPACE: &str = "${{ env.IMAGE_NAMESPACE }}";

/// What a job that pushes an image needs beyond reading the repository:
/// `packages` to push, and `id-token` with `attestations` to sign and store
/// the provenance of what it pushed. gh-workflow has no `attestations` field.
const PUBLISH_PERMISSIONS: &str =
    "contents: read\npackages: write\nid-token: write\nattestations: write\n";

/// The licence of this repository, which the fork's own images carry.
const REPOSITORY_LICENCE: &str = "AGPL-3.0-only";

/// One image and what it is built from. The names follow the variables
/// `infra/self-hosted/compose.yaml` reads them from (`SUPAMAC_SYNC_IMAGE` is
/// `supamac-sync`).
struct Image {
    /// The repository name in the registry.
    name: &'static str,
    dockerfile: &'static str,
    context: &'static str,
    /// The SPDX expression for what the image holds.
    licence: &'static str,
}

const SERVICES: Image = Image {
    name: "supamac-services",
    dockerfile: "infra/self-hosted/images/services.Dockerfile",
    context: SERVICES_CONTEXT,
    licence: REPOSITORY_LICENCE,
};

const SYNC: Image = Image {
    name: "supamac-sync",
    dockerfile: "docker/sync-service.Dockerfile",
    context: ".",
    licence: REPOSITORY_LICENCE,
};

// These three are built from the repository root with an ignore file of
// their own beside the Dockerfile, which BuildKit reads in place of the root
// `.dockerignore`: that one leaves out `/packages`, which the first two read.
const LEXICAL: Image = Image {
    name: "supamac-lexical",
    dockerfile: "infra/self-hosted/images/lexical-service.Dockerfile",
    context: ".",
    licence: REPOSITORY_LICENCE,
};

const AI_EDITING: Image = Image {
    name: "supamac-ai-editing",
    dockerfile: "infra/self-hosted/images/ai-editing-worker.Dockerfile",
    context: ".",
    licence: REPOSITORY_LICENCE,
};

const OPS: Image = Image {
    name: "supamac-ops",
    dockerfile: "infra/self-hosted/ops/Dockerfile",
    context: ".",
    licence: REPOSITORY_LICENCE,
};

/// OpenSearch with the one plugin the index mappings need, for the stack's
/// `search` profile. The image holds OpenSearch and nothing of this
/// repository but the Dockerfile.
const SEARCH: Image = Image {
    name: "supamac-search",
    dockerfile: "infra/local/opensearch/Dockerfile",
    context: "infra/local/opensearch",
    licence: "Apache-2.0",
};

/// Every job that pushes, by id. [`render`] gives each [`PUBLISH_PERMISSIONS`].
const PUBLISHING_JOBS: [&str; 4] = [
    "services-image",
    "sync-service-image",
    "workers-image",
    "ops-image",
];

/// Render the workflow, with the constructs gh-workflow cannot express.
pub fn render() -> Result<String> {
    let workflow = Workflow::new("SupaMac images")
        .permissions(Permissions::default().contents(Level::Read))
        .on(Event::default()
            .push(Push::default().add_branch("main"))
            .pull_request(pull_request())
            .workflow_dispatch(WorkflowDispatch::default()))
        .add_job("services", services())
        .add_job("services-image", services_image())
        .add_job(
            "sync-service-check",
            docker_images("the sync service image", &[SYNC], false),
        )
        .add_job(
            "sync-service-image",
            docker_images("the sync service image", &[SYNC], true),
        )
        .add_job(
            "workers-check",
            docker_images(
                "the lexical service and AI editing worker images",
                &[LEXICAL, AI_EDITING],
                false,
            ),
        )
        .add_job(
            "workers-image",
            docker_images(
                "the lexical service and AI editing worker images",
                &[LEXICAL, AI_EDITING],
                true,
            ),
        )
        .add_job(
            "ops-check",
            docker_images("the ops and search images", &[OPS, SEARCH], false),
        )
        .add_job(
            "ops-image",
            docker_images("the ops and search images", &[OPS, SEARCH], true),
        );

    let yaml = workflow
        .to_string()
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    let mut value: serde_yaml::Value = serde_yaml::from_str(&yaml)?;
    value["concurrency"] = fork_steps::delivery_concurrency()?;
    for job in PUBLISHING_JOBS {
        value["jobs"][job]["permissions"] = yaml_fragment(PUBLISH_PERMISSIONS)?;
    }
    serde_yaml::to_string(&value).map_err(Into::into)
}

/// A pull request builds the images only when it changes something they are
/// built from. Pushes to `main` are not filtered: every commit there gets
/// images under its own SHA.
fn pull_request() -> PullRequest {
    let paths = [
        xtask_paths::repo_glob!(".cargo/**"),
        xtask_paths::repo_glob!(".dockerignore"),
        xtask_paths::repo_glob!(".sqlx/**"),
        xtask_paths::repo_glob!("Cargo.lock"),
        xtask_paths::repo_glob!("Cargo.toml"),
        xtask_paths::repo_glob!("rust-toolchain.toml"),
        xtask_paths::repo_glob!("bun.lock"),
        xtask_paths::repo_glob!("bunfig.toml"),
        xtask_paths::repo_glob!("package.json"),
        xtask_paths::repo_glob!("apps/web/patches/**"),
        xtask_paths::repo_glob!("crates/**"),
        xtask_paths::repo_glob!("packages/**"),
        xtask_paths::repo_glob!("services/**"),
        xtask_paths::repo_glob!("vendor/**"),
        xtask_paths::repo_glob!("docker/sync-service.Dockerfile"),
        xtask_paths::repo_glob!("infra/self-hosted/**"),
        // What the ops and search images copy from outside that directory.
        xtask_paths::repo_glob!("infra/local/opensearch/**"),
        xtask_paths::repo_glob!("infra/stacks/opensearch/helpers/**"),
        xtask_paths::repo_glob!("infra/stacks/fusionauth-instance/templates/populate_jwt_local.js"),
        xtask_paths::repo_glob!(".github/kafka-cluster-topics.json"),
        xtask_paths::repo_glob!("tooling/xtask/crates/xtask_workflows/src/workflows/fork_steps.rs"),
        xtask_paths::repo_glob!(
            "tooling/xtask/crates/xtask_workflows/src/workflows/supamac_images.rs"
        ),
        xtask_paths::repo_glob!(
            "tooling/xtask/crates/xtask_workflows/src/workflows/supamac_images/**"
        ),
        xtask_paths::repo_glob!(".github/workflows/supamac-images.yml"),
    ];

    let mut pull_request = PullRequest::default().add_branch("main");
    for path in paths {
        pull_request = pull_request.add_path(path);
    }
    pull_request
}

/// Compile every service on the runner and check the image they go into.
///
/// On the runner, not inside Docker: the root `.dockerignore` leaves out
/// `/packages`, which two build scripts read, and one cargo invocation on the
/// host compiles the crates the services share once. The job holds no
/// registry permission, since cargo runs the build scripts of every
/// dependency here; [`services_image`] publishes what it built.
fn services() -> Job {
    Job::default()
        .name("Build the service binaries")
        .runs_on(fork_steps::RUNNER)
        // A hosted job ends after 360 minutes. The build step gives up
        // before the job does, so a build that ran out of time still keeps
        // what it compiled.
        .timeout_minutes(350u32)
        .add_env(("RUSTUP_TOOLCHAIN", fork_steps::RUST_TOOLCHAIN))
        // SQLx macros read the tracked query metadata, never a database.
        .add_env(("SQLX_OFFLINE", "true"))
        // Two compilers at a time. A 16 GB runner has been lost to a wider
        // release build; raise this once a run has shown its peak memory.
        .add_env(("CARGO_BUILD_JOBS", "2"))
        .add_env(("CARGO_INCREMENTAL", "0"))
        .add_env(("CARGO_TERM_COLOR", "always"))
        .add_step(steps::checkout(false, false))
        .add_step(fork_steps::free_disk_space())
        .add_step(install_build_packages())
        .add_step(fork_steps::install_rust(&[]))
        .add_step(fork_steps::setup_bun())
        .add_step(generate_code_mode_assets())
        .add_step(restore_cargo_cache())
        .add_step(build_services())
        .add_step(assemble_services_context())
        .add_step(trim_cargo_target())
        .add_step(save_cargo_cache())
        .add_step(setup_buildx())
        .add_step(build_services_check_image())
        .add_step(check_services_image())
        .add_step(pack_services_context())
        .add_step(upload_services_context())
}

/// What the C code in the dependency graph needs beyond the hosted image's
/// compilers. cmake builds librdkafka, which fails without curl's headers
/// although curl is not linked. The SASL headers were installed in the build
/// this list was measured with.
fn install_build_packages() -> Step<Run> {
    Step::new("Install build packages").run(indoc::indoc! {r#"
        sudo apt-get update
        sudo apt-get install --yes --no-install-recommends build-essential cmake libcurl4-openssl-dev libsasl2-dev perl pkg-config
    "#})
}

/// `crates/code_mode_assets` embeds assets generated from the SDK. Its build
/// script would run this generator itself, on every cargo invocation and with
/// `node_modules` still on disk; given `CODE_MODE_ASSETS_DIR` it reads the
/// prebuilt directory, and the install's 3 GB go back to the build.
fn generate_code_mode_assets() -> Step<Run> {
    Step::new("Generate the code-mode assets").run(indoc::indoc! {r#"
        bun install --frozen-lockfile --ignore-scripts
        bun packages/code-mode-sdk/scripts/generate.ts "$RUNNER_TEMP/code-mode-assets"
        echo "CODE_MODE_ASSETS_DIR=$RUNNER_TEMP/code-mode-assets" >> "$GITHUB_ENV"
        find . -name node_modules -type d -prune -exec rm -rf {} +
    "#})
}

/// The crate downloads and the release build of an earlier run on `main`. An
/// entry is named by `Cargo.lock`; without one for this lockfile the run
/// starts from the newest entry of an unfinished build of it, then of any
/// other lockfile.
fn restore_cargo_cache() -> Step<Use> {
    let toolchain = fork_steps::RUST_TOOLCHAIN;
    let prefix = format!("supamac-services-${{{{ runner.os }}}}-rust{toolchain}-");
    let lockfile = format!("{prefix}${{{{ hashFiles('Cargo.lock') }}}}");

    Step::new("Restore the cargo cache")
        .uses("actions/cache", "restore", fork_steps::ACTIONS_CACHE)
        .id("cargo-cache")
        .add_with(("path", CARGO_CACHE_PATHS))
        .add_with(("key", lockfile.clone()))
        .add_with(("restore-keys", format!("{lockfile}-\n{prefix}\n")))
}

/// The registry's index and archives (cargo unpacks sources from them), git
/// dependencies, and the release build.
const CARGO_CACHE_PATHS: &str =
    "~/.cargo/registry/index\n~/.cargo/registry/cache\n~/.cargo/git\ntarget/release\n";

/// One cargo invocation for every service, so the crates they share compile
/// once, with default features only. A feature named here would be unified
/// into every binary of the invocation, and the local stack's features let a
/// request name its own user (`local_auth`), return login codes in the
/// response (`return_passwordless_code`) and lift rate limits
/// (`no_rate_limit`).
fn build_services() -> Step<Run> {
    let mut command = String::from("cargo build --release --locked");
    for (package, binaries) in SERVICE_BINARIES {
        command.push_str(&format!(" \\\n  -p {package}"));
        for binary in binaries {
            command.push_str(&format!(" --bin {binary}"));
        }
    }
    command.push('\n');

    Step::new("Build every service in one cargo invocation")
        .run(command)
        .id("build")
        .timeout_minutes(300u32)
}

/// Every binary [`SERVICE_BINARIES`] names, separated by spaces.
fn service_binary_names() -> String {
    SERVICE_BINARIES
        .iter()
        .flat_map(|(_, binaries)| binaries.iter().copied())
        .collect::<Vec<_>>()
        .join(" ")
}

fn assemble_services_context() -> Step<Run> {
    Step::new("Strip the binaries into the image context")
        .run(include_str!("supamac_images/assemble_services_context.sh"))
        .add_env(("BINARIES", service_binary_names()))
        .add_env(("CONTEXT", SERVICES_CONTEXT))
        .add_env(("PDFIUM_SHA256", PDFIUM_SHA256))
}

/// Only `main` writes the cache, so a pull request can never change what a
/// publishing run starts from; a run that found its lockfile's entry has
/// nothing to add. A build that failed or ran out of time saves what it
/// compiled under a name of its own, and the next run goes on from there.
const SAVES_CARGO_CACHE: &str = "!cancelled() && github.ref == 'refs/heads/main' && github.event_name != 'pull_request' && steps.cargo-cache.outputs.cache-hit != 'true' && steps.build.outcome != 'skipped'";

fn trim_cargo_target() -> Step<Run> {
    Step::new("Drop the linked binaries from the cargo cache")
        .run(include_str!("supamac_images/trim_cargo_target.sh"))
        .if_condition(Expression::new(SAVES_CARGO_CACHE))
}

fn save_cargo_cache() -> Step<Use> {
    Step::new("Save the cargo cache")
        .uses("actions/cache", "save", fork_steps::ACTIONS_CACHE)
        .if_condition(Expression::new(SAVES_CARGO_CACHE))
        .add_with(("path", CARGO_CACHE_PATHS))
        .add_with((
            "key",
            "${{ steps.cargo-cache.outputs.cache-primary-key }}${{ steps.build.outcome != 'success' && format('-partial-{0}-{1}', github.run_id, github.run_attempt) || '' }}",
        ))
}

fn setup_buildx() -> Step<Use> {
    Step::new("Set up Docker Buildx").uses("docker", "setup-buildx-action", SETUP_BUILDX)
}

/// Build the services image into the runner's Docker, so the next step can
/// run it. The publishing job builds it again from the same context.
fn build_services_check_image() -> Step<Use> {
    Step::new("Build the services image")
        .uses("docker", "build-push-action", BUILD_PUSH)
        .add_with(("context", SERVICES.context))
        .add_with(("file", SERVICES.dockerfile))
        .add_with(("platforms", "linux/amd64"))
        .add_with(("load", true))
        .add_with(("tags", SERVICES_CHECK_IMAGE))
}

fn check_services_image() -> Step<Run> {
    Step::new("Check the image runs what was built")
        .run(include_str!("supamac_images/check_services_image.sh"))
        .add_env(("BINARIES", service_binary_names()))
        .add_env(("IMAGE", SERVICES_CHECK_IMAGE))
}

fn pack_services_context() -> Step<Run> {
    Step::new("Pack the image context")
        .run("tar --create --zstd --file \"$ARCHIVE\" --directory \"$CONTEXT\" .")
        .if_condition(Expression::new(fork_steps::NOT_ON_PULL_REQUEST))
        .add_env(("ARCHIVE", SERVICES_ARCHIVE))
        .add_env(("CONTEXT", SERVICES_CONTEXT))
}

fn upload_services_context() -> Step<Use> {
    Step::new("Hand the image context to the publishing job")
        .uses("actions", "upload-artifact", fork_steps::UPLOAD_ARTIFACT)
        .if_condition(Expression::new(fork_steps::NOT_ON_PULL_REQUEST))
        .add_with(("name", SERVICES_ARTIFACT))
        .add_with(("path", SERVICES_ARCHIVE))
        .add_with(("if-no-files-found", "error"))
        // Already compressed, and read once by the next job.
        .add_with(("compression-level", 0))
        .add_with(("retention-days", 1))
        // A run that is started again uploads under the same name.
        .add_with(("overwrite", true))
}

/// Publish the image of the binaries [`services`] built. This job runs no
/// code of the build: it unpacks the context and builds a Dockerfile that
/// installs Debian packages and copies files.
fn services_image() -> Job {
    let job = Job::default()
        .name("Publish the services image")
        .runs_on(fork_steps::RUNNER)
        .timeout_minutes(30u32)
        .add_needs("services")
        .cond(Expression::new(fork_steps::NOT_ON_PULL_REQUEST))
        .add_step(steps::checkout(false, false))
        .add_step(
            Step::new("Fetch the image context")
                .uses(
                    "actions",
                    "download-artifact",
                    fork_steps::DOWNLOAD_ARTIFACT,
                )
                .add_with(("name", SERVICES_ARTIFACT))
                .add_with(("path", "${{ runner.temp }}")),
        )
        .add_step(
            Step::new("Unpack the image context")
                .run("mkdir \"$CONTEXT\"\ntar --extract --zstd --file \"$ARCHIVE\" --directory \"$CONTEXT\"\n")
                .add_env(("ARCHIVE", SERVICES_ARCHIVE))
                .add_env(("CONTEXT", SERVICES_CONTEXT)),
        )
        .add_step(setup_buildx())
        .add_step(name_registry_namespace())
        .add_step(log_in_to_registry());
    publish(job, &SERVICES)
}

/// Build images whose Dockerfile does all of the work, from the checkout.
/// `publish` chooses between the two jobs each such group gets: the one that
/// runs on pull requests, builds and holds no registry permission, and the
/// one that runs otherwise and pushes.
fn docker_images(what: &str, images: &[Image], publish_images: bool) -> Job {
    let (name, condition) = if publish_images {
        (format!("Publish {what}"), fork_steps::NOT_ON_PULL_REQUEST)
    } else {
        (format!("Build {what}"), fork_steps::ON_PULL_REQUEST)
    };

    let mut job = Job::default()
        .name(name)
        .runs_on(fork_steps::RUNNER)
        .timeout_minutes(120u32)
        .cond(Expression::new(condition))
        .add_step(steps::checkout(false, false))
        .add_step(fork_steps::free_disk_space())
        .add_step(setup_buildx());

    if !publish_images {
        for image in images {
            job = job.add_step(build_without_pushing(image));
        }
        return job;
    }

    job = job
        .add_step(name_registry_namespace())
        .add_step(log_in_to_registry());
    for image in images {
        job = publish(job, image);
    }
    job
}

fn build_without_pushing(image: &Image) -> Step<Use> {
    Step::new(format!("Build {}", image.name))
        .uses("docker", "build-push-action", BUILD_PUSH)
        .add_with(("context", image.context))
        .add_with(("file", image.dockerfile))
        .add_with(("platforms", "linux/amd64"))
        .add_with(("push", false))
}

/// A registry path is lower-case, and an account name need not be.
fn name_registry_namespace() -> Step<Run> {
    Step::new("Name the registry namespace")
        .run("echo \"IMAGE_NAMESPACE=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}\" >> \"$GITHUB_ENV\"")
}

fn log_in_to_registry() -> Step<Use> {
    Step::new("Log in to the container registry")
        .uses("docker", "login-action", LOGIN)
        .add_with(("registry", "ghcr.io"))
        .add_with(("username", "${{ github.actor }}"))
        .add_with(("password", "${{ secrets.GITHUB_TOKEN }}"))
}

/// Push one image and say what was pushed: the image under its commit, and
/// under `latest` on `main` alone; BuildKit's provenance and SBOM beside it
/// in the registry; a signed provenance attestation; and its digest in the
/// job summary, which is what a deployment pins.
fn publish(job: Job, image: &Image) -> Job {
    let name = image.name;
    let build = format!("build-{name}");
    let repository = format!("{IMAGE_NAMESPACE}/{name}");
    let digest = format!("${{{{ steps.{build}.outputs.digest }}}}");

    let tags = format!(
        "{repository}:${{{{ github.sha }}}}\n${{{{ github.ref == 'refs/heads/main' && format('{{0}}/{name}:latest', env.IMAGE_NAMESPACE) || '' }}}}\n"
    );
    let labels = format!(
        "org.opencontainers.image.title={name}\norg.opencontainers.image.source=${{{{ github.server_url }}}}/${{{{ github.repository }}}}\norg.opencontainers.image.revision=${{{{ github.sha }}}}\norg.opencontainers.image.licenses={licence}\n",
        licence = image.licence
    );

    job.add_step(
        Step::new(format!("Build and push {name}"))
            .uses("docker", "build-push-action", BUILD_PUSH)
            .id(build)
            .add_with(("context", image.context))
            .add_with(("file", image.dockerfile))
            .add_with(("platforms", "linux/amd64"))
            .add_with(("push", true))
            .add_with(("tags", tags))
            .add_with(("labels", labels))
            .add_with(("provenance", "mode=max"))
            .add_with(("sbom", true)),
    )
    .add_step(
        Step::new(format!("Attest the provenance of {name}"))
            .uses(
                "actions",
                "attest-build-provenance",
                ATTEST_BUILD_PROVENANCE,
            )
            .add_with(("subject-name", repository.clone()))
            .add_with(("subject-digest", digest.clone()))
            .add_with(("push-to-registry", true))
            // A storage record is an organisation's inventory of artifacts
            // and needs a permission of its own.
            .add_with(("create-storage-record", false)),
    )
    .add_step(
        Step::new(format!("Report the digest of {name}"))
            .run(include_str!("supamac_images/report_digest.sh"))
            .add_env(("IMAGE", repository))
            .add_env(("DIGEST", digest)),
    )
}
