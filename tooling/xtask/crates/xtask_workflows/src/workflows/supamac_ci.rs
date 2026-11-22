//! Fork-owned analysis on GitHub-hosted runners, with no deployment credentials.

use anyhow::Result;
use gh_workflow::expr::typed::{Str, cancelled, matrix};
use gh_workflow::{
    Concurrency, Event, Job, Level, Permissions, PullRequest, Push, Schedule, Step, Strategy,
    Workflow, WorkflowDispatch,
};

use crate::workflows::actions::{
    DeterminateSystemsNixInstallerAction, GithubCodeqlActionAnalyze, GithubCodeqlActionInit,
};
use crate::workflows::fork_steps::{self, setup_bun};
use crate::workflows::steps;

#[cfg(test)]
mod test;

/// The languages CodeQL analyses, each with its job's time limit in minutes.
/// One job per language and not one job over a matrix: the two limits differ,
/// and the model holds a job's limit as a number.
const CODEQL_LANGUAGES: [(&str, u32); 2] = [("javascript-typescript", 45), ("rust", 120)];

/// Render the fork CI.
pub fn render() -> Result<String> {
    fork_steps::render(workflow())
}

fn workflow() -> Workflow {
    let workflow = Workflow::new("SupaMac CI")
        .permissions(Permissions::default().contents(Level::Read))
        .on(Event::default()
            .push(Push::default().add_branch("main"))
            .pull_request(PullRequest::default().add_branch("main"))
            .add_schedule(Schedule::new("31 7 * * 1"))
            .workflow_dispatch(WorkflowDispatch::default()))
        .concurrency(Concurrency::new(fork_steps::concurrency_group()).cancel_in_progress(true))
        .add_job("tooling", tooling())
        .add_job("dependencies", dependencies())
        .add_job("nix-dependencies", nix_dependencies());

    CODEQL_LANGUAGES
        .into_iter()
        .fold(workflow, |workflow, (language, timeout_minutes)| {
            workflow.add_job(
                format!("codeql-{language}"),
                codeql(language, timeout_minutes),
            )
        })
        .add_job("secrets", secrets())
}

/// The generator and the model it renders through are both checked: a change
/// to either rewrites every workflow.
fn tooling() -> Job {
    Job::default()
        .name("Fork tooling and workflow checks")
        .runs_on(fork_steps::RUNNER)
        .timeout_minutes(30u32)
        .add_env(("RUSTUP_TOOLCHAIN", fork_steps::RUST_TOOLCHAIN))
        .add_step(steps::checkout(false, false))
        .add_step(setup_bun())
        .add_step(Step::new("Install locked analysis dependencies").run("bun install --frozen-lockfile --ignore-scripts"))
        .add_step(fork_steps::install_rust(&["--component rustfmt", "--component clippy"]))
        .add_step(Step::new("Check and test fork tooling").run("cargo fmt --all -- --check\ncargo clippy --locked -p xtask_workflows -p gh_workflow -- -D warnings\ncargo test --locked -p xtask_workflows -p gh_workflow\ncargo x workflows --check\nbun test tooling/supamac\nbun node_modules/typescript-native/bin/tsc --noEmit --strict --skipLibCheck --types bun --target es2022 --module esnext --moduleResolution bundler tooling/supamac/*.ts\n"))
}

fn dependencies() -> Job {
    Job::default()
        .name("Live dependency advisories")
        .runs_on(fork_steps::RUNNER)
        .timeout_minutes(30u32)
        .add_step(steps::checkout(false, false))
        .add_step(setup_bun())
        .add_step(
            Step::new("Audit JavaScript workspace lockfiles")
                .run("bun tooling/supamac/audit-dependencies.ts"),
        )
        .add_step(
            Step::new("Install pinned Rust advisory scanner")
                .run(indoc::indoc! {r#"
                    curl -fsSL https://github.com/rustsec/rustsec/releases/download/cargo-audit/v0.23.0/cargo-audit-x86_64-unknown-linux-gnu-v0.23.0.tgz -o "$RUNNER_TEMP/cargo-audit.tgz"
                    printf 'b77993532b253fcbf550996d7716465ec3d734d4e74e7f87bfb65a19add0fb59  %s\n' "$RUNNER_TEMP/cargo-audit.tgz" | sha256sum --check
                    tar -xzf "$RUNNER_TEMP/cargo-audit.tgz" -C "$RUNNER_TEMP"
                "#})
                .if_condition(!cancelled()),
        )
        .add_step(
            Step::new("Audit Rust dependencies")
                .run("\"$RUNNER_TEMP/cargo-audit-x86_64-unknown-linux-gnu-v0.23.0/cargo-audit\" audit --file Cargo.lock --deny warnings")
                .if_condition(!cancelled()),
        )
}

fn nix_dependencies() -> Job {
    let runner = || matrix::<Str>("runner");
    let package = || matrix::<Str>("package");

    Job::default()
        .name(format!("Nix dependencies ({}, {})", runner(), package()))
        .runs_on(runner())
        .timeout_minutes(60u32)
        .strategy(Strategy::default().fail_fast(false).matrix(serde_json::json!({
            "include": [
                { "package": "js-node-modules", "runner": "ubuntu-24.04" },
                { "package": "js-node-modules", "runner": "macos-15" },
                { "package": "macro-agent-node-modules", "runner": "ubuntu-24.04" },
            ],
        })))
        .add_env(("NIX_PACKAGE", package()))
        .add_step(steps::checkout(false, false))
        .add_step(
            DeterminateSystemsNixInstallerAction::new("Install Nix")
                .determinate(false)
                .kvm(false)
                .diagnostic_endpoint("")
                .step(),
        )
        .add_step(
            Step::new("Verify locked dependency output")
                // Rebuild even a substituted output: its store path depends on
                // the declared hash, so a cache hit alone cannot verify a new lock.
                .run("nix build --no-link --no-update-lock-file \".#$NIX_PACKAGE\"\nnix build --no-link --no-update-lock-file --rebuild \".#$NIX_PACKAGE\"\n"),
        )
        .add_step(
            Step::new("Build agent runtime against locked dependencies")
                .run("nix build --no-link --no-update-lock-file .#macro-agent-runtime")
                .if_condition(package().eq("macro-agent-node-modules")),
        )
}

/// Static analysis of one language. The job alone may write security events.
fn codeql(language: &str, timeout_minutes: u32) -> Job {
    Job::default()
        .name(format!("CodeQL ({language})"))
        .runs_on(fork_steps::RUNNER)
        .permissions(
            Permissions::default()
                .contents(Level::Read)
                .security_events(Level::Write),
        )
        .timeout_minutes(timeout_minutes)
        // SQLx macros must use tracked query metadata, never a live database.
        // Keep this scoped to static analysis; database tests run online.
        .add_env(("SQLX_OFFLINE", "true"))
        .add_env(("CARGO_BUILD_JOBS", "2"))
        .add_step(steps::checkout(false, false))
        .add_step(
            GithubCodeqlActionInit::new("Initialize CodeQL")
                .languages(language)
                .build_mode("none")
                // Leave headroom for the runner and Rust macro compilation.
                .ram("4096")
                .threads("2")
                .queries("security-extended")
                .step(),
        )
        .add_step(
            GithubCodeqlActionAnalyze::new("Analyse source")
                .category(format!("/language:{language}"))
                .step(),
        )
}

fn secrets() -> Job {
    Job::default()
        .name("Secrets scan")
        .runs_on(fork_steps::RUNNER)
        .timeout_minutes(15u32)
        .add_step(steps::checkout(false, false))
        .add_step(
            Step::new("Install pinned secret scanner")
                .run(indoc::indoc! {r#"
                    curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz -o "$RUNNER_TEMP/gitleaks.tgz"
                    printf '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  %s\n' "$RUNNER_TEMP/gitleaks.tgz" | sha256sum --check
                    tar -xzf "$RUNNER_TEMP/gitleaks.tgz" -C "$RUNNER_TEMP" gitleaks
                "#}),
        )
        .add_step(
            Step::new("Scan working tree with redacted output")
                .run("\"$RUNNER_TEMP/gitleaks\" dir --redact --no-banner ."),
        )
}
