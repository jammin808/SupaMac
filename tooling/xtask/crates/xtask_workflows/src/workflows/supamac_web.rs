//! The web bundle of a self-hosted instance, built on a GitHub-hosted runner
//! for the folder and backend named in repository variables. A pull request
//! builds, tests and packages it; a run on `main` also publishes the packaged
//! folder as the only commit of [`PUBLISH_BRANCH`], which the host deploys
//! from. docs/supamac/delivery.md describes the variables and the branch.

use anyhow::Result;
use gh_workflow::expr::typed::{Bool, Expr, StepHandle, StepOutput, Str, Var, github, runner};
use gh_workflow::{
    Event, Job, Level, Permissions, PullRequest, Push, Run, Step, Use, Workflow, WorkflowDispatch,
};

use crate::workflows::actions::{ActionsDownloadArtifact, ActionsUploadArtifact};
use crate::workflows::{fork_steps, steps};

#[cfg(test)]
mod test;

/// The branch that holds the built files and nothing else.
const PUBLISH_BRANCH: &str = "supamac-web-dist";

/// The job that builds and packages the bundle, which the job that publishes
/// it waits for.
const BUILD_JOB: &str = "build";

/// The name the packaging tool gives the folder to publish. It writes the
/// upload order beside it, under [`SITE_MANIFEST_NAME`].
const SITE_NAME: &str = "supamac-web";
const SITE_MANIFEST_NAME: &str = "supamac-web.publish.json";

const ARTIFACT: &str = "supamac-web";

/// Where the publishing job unpacks [`ARTIFACT`]: the folder and its manifest
/// keep their names below it.
fn downloaded() -> String {
    format!("{}/published", runner().temp())
}

/// The folder the bundle is served from, such as `/workspace`.
const BASE_PATH_VARIABLE: Var = Var("SUPAMAC_WEB_BASE_PATH");

/// The backend's https origin, with no path.
const BACKEND_ORIGIN_VARIABLE: Var = Var("SUPAMAC_BACKEND_ORIGIN");

/// What the build's first step resolved the two variables to.
struct BuildInputs {
    base_path: StepOutput<Str>,
    backend_origin: StepOutput<Str>,
}

/// The build's first step. Only the steps that build and package the bundle
/// are given its outputs, as `MACRO_APP_BASE_PATH` and `VITE_BACKEND_ORIGIN`:
/// in the environment of the whole job they would reach the unit tests, which
/// cover the hosted and the local service addresses too and fail with a
/// backend origin set.
const INPUTS: StepHandle<BuildInputs> = StepHandle::new(
    "inputs",
    BuildInputs {
        base_path: StepOutput::new("inputs", "base_path"),
        backend_origin: StepOutput::new("inputs", "backend_origin"),
    },
);

/// Only a run on `main` that is not a pull request publishes: a push, or a
/// manual run, which publishes again after a variable changed.
fn publishes() -> Expr<Bool> {
    github()
        .git_ref()
        .eq(fork_steps::MAIN_REF)
        .and(fork_steps::not_on_pull_request())
}

/// Render the workflow.
pub fn render() -> Result<String> {
    fork_steps::render_delivery(workflow())
}

fn workflow() -> Workflow {
    Workflow::new("SupaMac web")
        .permissions(Permissions::default().contents(Level::Read))
        .on(Event::default()
            .push(Push::default().add_branch("main"))
            .pull_request(pull_request())
            .workflow_dispatch(WorkflowDispatch::default()))
        .add_job(BUILD_JOB, build())
        .add_job("publish", publish())
}

/// A pull request builds the bundle only when it changes something the bundle
/// is built from. Pushes to `main` are not filtered.
fn pull_request() -> PullRequest {
    let paths = [
        xtask_paths::repo_glob!(".cargo/**"),
        xtask_paths::repo_glob!("Cargo.lock"),
        xtask_paths::repo_glob!("Cargo.toml"),
        xtask_paths::repo_glob!("rust-toolchain.toml"),
        xtask_paths::repo_glob!("bun.lock"),
        xtask_paths::repo_glob!("bunfig.toml"),
        xtask_paths::repo_glob!("package.json"),
        xtask_paths::repo_glob!("apps/web/**"),
        xtask_paths::repo_glob!("crates/**"),
        xtask_paths::repo_glob!("packages/**"),
        xtask_paths::repo_glob!("vendor/**"),
        xtask_paths::repo_glob!("tooling/supamac/**"),
        xtask_paths::repo_glob!("tooling/xtask/crates/xtask_workflows/src/workflows/fork_steps.rs"),
        xtask_paths::repo_glob!(
            "tooling/xtask/crates/xtask_workflows/src/workflows/supamac_web.rs"
        ),
        xtask_paths::repo_glob!(
            "tooling/xtask/crates/xtask_workflows/src/workflows/supamac_web/**"
        ),
        xtask_paths::repo_glob!(".github/workflows/supamac-web.yml"),
    ];

    let mut pull_request = PullRequest::default().add_branch("main");
    for path in paths {
        pull_request = pull_request.add_path(path);
    }
    pull_request
}

fn build() -> Job {
    let web = xtask_paths::repo_dir!("apps/web");

    Job::default()
        .name("Build and package the web bundle")
        .runs_on(fork_steps::RUNNER)
        .timeout_minutes(60u32)
        .add_env(("RUSTUP_TOOLCHAIN", fork_steps::RUST_TOOLCHAIN))
        .add_env(("CARGO_TERM_COLOR", "always"))
        // First, so a run that cannot publish stops before it builds.
        .add_step(resolve_build_inputs())
        .add_step(steps::checkout(false, false))
        .add_step(fork_steps::setup_bun())
        .add_step(
            Step::new("Install locked dependencies")
                .run("bun install --frozen-lockfile --ignore-scripts"),
        )
        .add_step(fork_steps::install_rust(&[
            "--target wasm32-unknown-unknown",
        ]))
        .add_step(
            Step::new("Install pinned WebAssembly tooling")
                .run(include_str!("supamac_web/install_wasm_tools.sh")),
        )
        .add_step(
            // The app imports ten WebAssembly packages that are built, not
            // tracked; without them those features fail at run time.
            Step::new("Build the WebAssembly packages")
                .run("just build-wasm")
                .working_directory(web),
        )
        .add_step(
            // The unit tests of what the two build inputs select: the service
            // addresses, and the links built on and read against the base
            // path. Each test sets the input it tests itself.
            Step::new("Test the self-hosted build inputs")
                .run("bunx vitest run src/lib/core/constant/servers.test.ts src/lib/core/util/macroAppUrl.test.ts src/lib/core/util/url.test.ts")
                .working_directory(web),
        )
        .add_step(
            Step::new("Build the bundle")
                .run("bun run --bun build")
                .working_directory(web)
                .add_env(("MODE", "production"))
                .add_env(("NODE_ENV", "production"))
                .add_env(("MACRO_APP_BASE_PATH", INPUTS.outputs.base_path.read()))
                .add_env((
                    "VITE_BACKEND_ORIGIN",
                    INPUTS.outputs.backend_origin.read(),
                ))
                // Vite's chunk rendering can pass 6 GB.
                .add_env(("NODE_OPTIONS", "--max-old-space-size=8192")),
        )
        .add_step(package())
        .add_step(upload())
}

fn resolve_build_inputs() -> Step<Run> {
    Step::new("Resolve the folder and the backend to build for")
        .run(include_str!("supamac_web/resolve_build_inputs.sh"))
        .id(INPUTS.id())
        .add_env(("CONFIGURED_BASE_PATH", BASE_PATH_VARIABLE))
        .add_env(("CONFIGURED_BACKEND_ORIGIN", BACKEND_ORIGIN_VARIABLE))
}

/// The Content Security Policy is report-only and the tutorial videos are
/// included unless the deployment's variables say otherwise.
fn package() -> Step<Run> {
    Step::new("Package the folder to publish")
        .run(include_str!("supamac_web/package.sh"))
        .add_env(("MACRO_APP_BASE_PATH", INPUTS.outputs.base_path.read()))
        .add_env(("VITE_BACKEND_ORIGIN", INPUTS.outputs.backend_origin.read()))
        .add_env(("SITE", format!("{}/{SITE_NAME}", runner().temp())))
        .add_env(("ENFORCE_CSP", Var("SUPAMAC_WEB_ENFORCE_CSP")))
        .add_env(("OMIT_VIDEOS", Var("SUPAMAC_WEB_OMIT_VIDEOS")))
}

fn upload() -> Step<Use> {
    let temp = runner().temp();
    ActionsUploadArtifact::new(
        "Upload the folder to publish",
        format!("{temp}/{SITE_NAME}\n{temp}/{SITE_MANIFEST_NAME}\n"),
    )
    .name(ARTIFACT)
    .if_no_files_found("error")
    // `.htaccess` is a hidden file and the folder does not work without it.
    .include_hidden_files(true)
    .retention_days(3)
    // A run that is started again uploads under the same name.
    .overwrite(true)
    .step()
}

/// The one job that can write to the repository. It checks nothing out and
/// runs no code of the build: it downloads the packaged folder and pushes it.
fn publish() -> Job {
    let downloaded = downloaded();

    Job::default()
        .name("Publish the web bundle")
        .runs_on(fork_steps::RUNNER)
        .timeout_minutes(15u32)
        .add_needs(BUILD_JOB)
        .cond(publishes())
        .permissions(Permissions::default().contents(Level::Write))
        .add_step(
            ActionsDownloadArtifact::new("Fetch the folder to publish")
                .name(ARTIFACT)
                .path(&downloaded)
                .step(),
        )
        .add_step(
            Step::new(format!(
                "Make the folder the only commit of {PUBLISH_BRANCH}"
            ))
            .run(include_str!("supamac_web/publish_branch.sh"))
            .add_env(("SITE", format!("{downloaded}/{SITE_NAME}")))
            .add_env(("MANIFEST", format!("{downloaded}/{SITE_MANIFEST_NAME}")))
            .add_env(("EXPECTED_BASE_PATH", BASE_PATH_VARIABLE))
            .add_env(("EXPECTED_BACKEND_ORIGIN", BACKEND_ORIGIN_VARIABLE))
            .add_env((
                "REMOTE",
                format!("{}/{}.git", github().server_url(), github().repository()),
            ))
            .add_env(("BRANCH", PUBLISH_BRANCH))
            .add_env(("SOURCE_SHA", github().sha()))
            .add_env(("GITHUB_TOKEN", fork_steps::RUN_TOKEN)),
        )
}
