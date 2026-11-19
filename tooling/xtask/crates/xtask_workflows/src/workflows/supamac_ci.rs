//! Fork-owned analysis on GitHub-hosted runners, with no deployment credentials.

use anyhow::Result;
use gh_workflow::{
    Concurrency, Event, Expression, Job, Level, Permissions, PullRequest, Push, Schedule, Step,
    Workflow, WorkflowDispatch,
};

use crate::workflows::{steps, yaml_fragment};

#[cfg(test)]
mod test;

fn setup_bun() -> gh_workflow::Step<gh_workflow::Use> {
    Step::new("Setup Bun for current lockfile formats")
        .uses(
            "oven-sh",
            "setup-bun",
            "0c5077e51419868618aeaa5fe8019c62421857d6",
        )
        .add_with(("bun-version", "1.4.5"))
}

const CODEQL: &str = "33d7b85da1a04171e211befe2c739303b9a4c066"; // v4, resolved 2026-11-19

/// Render the fork CI, including CodeQL's permission absent from gh-workflow.
pub fn render() -> Result<String> {
    let workflow = Workflow::new("SupaMac CI")
        .permissions(Permissions::default().contents(Level::Read))
        .on(Event::default()
            .push(
                Push::default()
                    .add_branch("main")
                    .add_branch("jammin808/**"),
            )
            .pull_request(PullRequest::default().add_branch("main"))
            .add_schedule(Schedule::new("31 7 * * 1"))
            .workflow_dispatch(WorkflowDispatch::default()))
        .concurrency(
            Concurrency::new(Expression::new(
                "supamac-${{ github.workflow }}-${{ github.ref }}",
            ))
            .cancel_in_progress(true),
        )
        .add_job("tooling", tooling())
        .add_job("dependencies", dependencies())
        .add_job("codeql", codeql())
        .add_job("secrets", secrets());

    let yaml = workflow
        .to_string()
        .map_err(|error| anyhow::anyhow!("{error:?}"))?;
    let mut value: serde_yaml::Value = serde_yaml::from_str(&yaml)?;
    value["jobs"]["codeql"]["permissions"] =
        yaml_fragment("contents: read\nsecurity-events: write\n")?;
    value["jobs"]["codeql"]["strategy"] =
        yaml_fragment("fail-fast: false\nmatrix:\n  language: [javascript-typescript, rust]\n")?;
    serde_yaml::to_string(&value).map_err(Into::into)
}

fn tooling() -> Job {
    Job::default()
        .name("Fork tooling and workflow checks")
        .runs_on("ubuntu-24.04")
        .timeout_minutes(30u32)
        .add_env(("RUSTUP_TOOLCHAIN", "1.94.0"))
        .add_step(steps::checkout(false, false))
        .add_step(setup_bun())
        .add_step(Step::new("Install locked analysis dependencies").run("bun install --frozen-lockfile --ignore-scripts"))
        .add_step(Step::new("Install pinned Rust tooling").run("rustup toolchain install 1.94.0 --profile minimal --component rustfmt --component clippy"))
        .add_step(Step::new("Check and test fork tooling").run("cargo fmt --all -- --check\ncargo clippy --locked -p xtask_workflows -- -D warnings\ncargo test --locked -p xtask_workflows\ncargo x workflows --check\nbun test tooling/supamac\nbun node_modules/typescript-native/bin/tsc --noEmit --strict --skipLibCheck --types bun --target es2022 --module esnext --moduleResolution bundler tooling/supamac/*.ts\n"))
}

fn dependencies() -> Job {
    Job::default()
        .name("Live dependency advisories")
        .runs_on("ubuntu-24.04")
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
                .if_condition(Expression::new("!cancelled()")),
        )
        .add_step(
            Step::new("Audit Rust dependencies")
                .run("\"$RUNNER_TEMP/cargo-audit-x86_64-unknown-linux-gnu-v0.23.0/cargo-audit\" audit --file Cargo.lock --deny warnings")
                .if_condition(Expression::new("!cancelled()")),
        )
}

fn codeql() -> Job {
    Job::default()
        .name("CodeQL (${{ matrix.language }})")
        .runs_on("ubuntu-24.04")
        .timeout_minutes(45u32)
        .add_step(steps::checkout(false, false))
        .add_step(
            Step::new("Initialize CodeQL")
                .uses("github", "codeql-action/init", CODEQL)
                .add_with(("languages", "${{ matrix.language }}"))
                .add_with(("build-mode", "none"))
                .add_with(("queries", "security-extended")),
        )
        .add_step(
            Step::new("Analyse source")
                .uses("github", "codeql-action/analyze", CODEQL)
                .add_with(("category", "/language:${{ matrix.language }}")),
        )
}

fn secrets() -> Job {
    Job::default()
        .name("Secrets scan")
        .runs_on("ubuntu-24.04")
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
