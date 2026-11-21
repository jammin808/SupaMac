//! The web bundle of a self-hosted instance, built on a GitHub-hosted runner
//! for the folder and backend named in repository variables. A pull request
//! builds, tests and packages it; a run on `main` also publishes the packaged
//! folder as the only commit of [`PUBLISH_BRANCH`], which the host deploys
//! from. docs/supamac/delivery.md describes the variables and the branch.

use anyhow::Result;
use gh_workflow::{
    Event, Expression, Job, Level, Permissions, PullRequest, Push, Run, Step, Use, Workflow,
    WorkflowDispatch,
};

use crate::workflows::{fork_steps, steps};

#[cfg(test)]
mod test;

/// The branch that holds the built files and nothing else.
const PUBLISH_BRANCH: &str = "supamac-web-dist";

/// The folder to publish, as the packaging tool writes it. The tool writes
/// the upload order beside it, in [`SITE_MANIFEST`].
const SITE: &str = "${{ runner.temp }}/supamac-web";
const SITE_MANIFEST: &str = "${{ runner.temp }}/supamac-web.publish.json";

const ARTIFACT: &str = "supamac-web";

/// Where the publishing job unpacks [`ARTIFACT`]: the folder and its manifest
/// keep their names below it.
const DOWNLOADED: &str = "${{ runner.temp }}/published";

/// The folder the bundle is served from, such as `/workspace`.
const BASE_PATH_VARIABLE: &str = "${{ vars.SUPAMAC_WEB_BASE_PATH }}";

/// The backend's https origin, with no path.
const BACKEND_ORIGIN_VARIABLE: &str = "${{ vars.SUPAMAC_BACKEND_ORIGIN }}";

/// What the build's first step, `inputs`, resolved the two variables to. Only
/// the steps that build and package the bundle are given these, as
/// `MACRO_APP_BASE_PATH` and `VITE_BACKEND_ORIGIN`: in the environment of the
/// whole job they would reach the unit tests, which cover the hosted and the
/// local service addresses too and fail with a backend origin set.
const RESOLVED_BASE_PATH: &str = "${{ steps.inputs.outputs.base_path }}";
const RESOLVED_BACKEND_ORIGIN: &str = "${{ steps.inputs.outputs.backend_origin }}";

/// Only a run on `main` that is not a pull request publishes: a push, or a
/// manual run, which publishes again after a variable changed.
const PUBLISHES: &str = "github.ref == 'refs/heads/main' && github.event_name != 'pull_request'";

/// Render the workflow, with the concurrency block gh-workflow cannot express.
pub fn render() -> Result<String> {
    let workflow = Workflow::new("SupaMac web")
        .permissions(Permissions::default().contents(Level::Read))
        .on(Event::default()
            .push(Push::default().add_branch("main"))
            .pull_request(pull_request())
            .workflow_dispatch(WorkflowDispatch::default()))
        .add_job("build", build())
        .add_job("publish", publish());

    let yaml = workflow
        .to_string()
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    let mut value: serde_yaml::Value = serde_yaml::from_str(&yaml)?;
    value["concurrency"] = fork_steps::delivery_concurrency()?;
    serde_yaml::to_string(&value).map_err(Into::into)
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
                .add_env(("MACRO_APP_BASE_PATH", RESOLVED_BASE_PATH))
                .add_env(("VITE_BACKEND_ORIGIN", RESOLVED_BACKEND_ORIGIN))
                // Vite's chunk rendering can pass 6 GB.
                .add_env(("NODE_OPTIONS", "--max-old-space-size=8192")),
        )
        .add_step(package())
        .add_step(upload())
}

fn resolve_build_inputs() -> Step<Run> {
    Step::new("Resolve the folder and the backend to build for")
        .run(include_str!("supamac_web/resolve_build_inputs.sh"))
        .id("inputs")
        .add_env(("CONFIGURED_BASE_PATH", BASE_PATH_VARIABLE))
        .add_env(("CONFIGURED_BACKEND_ORIGIN", BACKEND_ORIGIN_VARIABLE))
}

/// The Content Security Policy is report-only and the tutorial videos are
/// included unless the deployment's variables say otherwise.
fn package() -> Step<Run> {
    Step::new("Package the folder to publish")
        .run(include_str!("supamac_web/package.sh"))
        .add_env(("MACRO_APP_BASE_PATH", RESOLVED_BASE_PATH))
        .add_env(("VITE_BACKEND_ORIGIN", RESOLVED_BACKEND_ORIGIN))
        .add_env(("SITE", SITE))
        .add_env(("ENFORCE_CSP", "${{ vars.SUPAMAC_WEB_ENFORCE_CSP }}"))
        .add_env(("OMIT_VIDEOS", "${{ vars.SUPAMAC_WEB_OMIT_VIDEOS }}"))
}

fn upload() -> Step<Use> {
    Step::new("Upload the folder to publish")
        .uses("actions", "upload-artifact", fork_steps::UPLOAD_ARTIFACT)
        .add_with(("name", ARTIFACT))
        .add_with(("path", format!("{SITE}\n{SITE_MANIFEST}\n")))
        .add_with(("if-no-files-found", "error"))
        // `.htaccess` is a hidden file and the folder does not work without it.
        .add_with(("include-hidden-files", true))
        .add_with(("retention-days", 3))
        // A run that is started again uploads under the same name.
        .add_with(("overwrite", true))
}

/// The one job that can write to the repository. It checks nothing out and
/// runs no code of the build: it downloads the packaged folder and pushes it.
fn publish() -> Job {
    Job::default()
        .name("Publish the web bundle")
        .runs_on(fork_steps::RUNNER)
        .timeout_minutes(15u32)
        .add_needs("build")
        .cond(Expression::new(PUBLISHES))
        .permissions(Permissions::default().contents(Level::Write))
        .add_step(
            Step::new("Fetch the folder to publish")
                .uses(
                    "actions",
                    "download-artifact",
                    fork_steps::DOWNLOAD_ARTIFACT,
                )
                .add_with(("name", ARTIFACT))
                .add_with(("path", DOWNLOADED)),
        )
        .add_step(
            Step::new(format!(
                "Make the folder the only commit of {PUBLISH_BRANCH}"
            ))
            .run(include_str!("supamac_web/publish_branch.sh"))
            .add_env(("SITE", format!("{DOWNLOADED}/supamac-web")))
            .add_env(("MANIFEST", format!("{DOWNLOADED}/supamac-web.publish.json")))
            .add_env(("EXPECTED_BASE_PATH", BASE_PATH_VARIABLE))
            .add_env(("EXPECTED_BACKEND_ORIGIN", BACKEND_ORIGIN_VARIABLE))
            .add_env((
                "REMOTE",
                "${{ github.server_url }}/${{ github.repository }}.git",
            ))
            .add_env(("BRANCH", PUBLISH_BRANCH))
            .add_env(("SOURCE_SHA", "${{ github.sha }}"))
            .add_env(("GITHUB_TOKEN", "${{ secrets.GITHUB_TOKEN }}")),
        )
}
