//! Settings and steps shared by the workflows this fork owns (`supamac_*`).
//! They run on GitHub-hosted runners with pinned tools and the run's own
//! token; `fork_policy::check_fork_owned` holds each of them to that.

use anyhow::{Context, Result, anyhow, bail};
use gh_workflow::expr::typed::{Bool, Expr, Secret, github};
use gh_workflow::{Concurrency, Run, Step, Use, Workflow};

use crate::workflows::actions::OvenShSetupBun;

#[cfg(test)]
mod test;

/// The GitHub-hosted image the fork's Linux jobs run on. Named exactly, not
/// `ubuntu-latest`: the service binaries link the runner's glibc, which must
/// not be newer than the one in the image they ship in.
pub const RUNNER: &str = "ubuntu-24.04";

/// The toolchain `rust-toolchain.toml` names. A job that compiles Rust sets
/// it as `RUSTUP_TOOLCHAIN`, so rustup uses this toolchain alone instead of
/// also fetching every component and target that file lists.
pub const RUST_TOOLCHAIN: &str = "1.94.0";

/// Bun at the version the fork's lockfiles are written by.
const BUN_VERSION: &str = "1.4.5";

/// The branch whose runs publish.
pub const MAIN_REF: &str = "refs/heads/main";

/// The token GitHub issues to each run, the only secret a fork-owned
/// workflow reads.
pub const RUN_TOKEN: Secret = Secret("GITHUB_TOKEN");

/// A pull request run: it builds and tests, and publishes nothing.
pub fn on_pull_request() -> Expr<Bool> {
    github().event_name().eq("pull_request")
}

/// A push to `main` or a manual run, which may publish.
pub fn not_on_pull_request() -> Expr<Bool> {
    github().event_name().ne("pull_request")
}

/// The concurrency group of a fork-owned workflow: one per workflow and ref,
/// so runs of one workflow on one ref never overlap.
pub fn concurrency_group() -> String {
    format!("supamac-{}-{}", github().workflow(), github().git_ref())
}

/// Bun at [`BUN_VERSION`].
pub fn setup_bun() -> Step<Use> {
    OvenShSetupBun::new("Setup Bun for current lockfile formats")
        .bun_version(BUN_VERSION)
        .step()
}

/// Install [`RUST_TOOLCHAIN`] with rustup's minimal profile plus `extras`,
/// each a `--component` or `--target` argument.
pub fn install_rust(extras: &[&str]) -> Step<Run> {
    let mut command = format!("rustup toolchain install {RUST_TOOLCHAIN} --profile minimal");
    for extra in extras {
        command.push(' ');
        command.push_str(extra);
    }
    Step::new("Install pinned Rust tooling").run(command)
}

/// Remove the SDKs the hosted image ships and no fork job uses. A hosted
/// runner starts with about 14 GB free, less than a release build of the
/// services or a Rust build inside Docker can need.
pub fn free_disk_space() -> Step<Run> {
    Step::new("Free disk space").run(indoc::indoc! {r#"
        df --human-readable --output=avail / | tail -n 1
        sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /usr/local/.ghcup /opt/hostedtoolcache/CodeQL
        df --human-readable --output=avail / | tail -n 1
    "#})
}

/// Render a fork-owned workflow, with every check the model makes.
pub fn render(workflow: Workflow) -> Result<String> {
    workflow.to_string().map_err(|error| anyhow!("{error}"))
}

/// The line a delivery workflow's concurrency is rendered with, which
/// [`render_delivery`] replaces. It starts at a line's first column, where
/// only a key of the workflow's own `concurrency` sits.
const CANCELS_NO_RUN: &str = "\n  cancel-in-progress: false\n";

/// Render a workflow that publishes. Runs of it on one ref never overlap. A
/// newer pull request run cancels the older one. On any other ref the run in
/// progress finishes, because it may be half way through publishing, and of
/// the runs that queue behind it GitHub keeps the newest.
///
/// The model holds `cancel-in-progress` as a boolean, so the workflow is
/// rendered with `false` and that one line is then written as the
/// expression. The result is read back: the line must be the only one that
/// changed.
pub fn render_delivery(workflow: Workflow) -> Result<String> {
    let concurrency = Concurrency::new(concurrency_group()).cancel_in_progress(false);
    let rendered = render(workflow.concurrency(concurrency))?;

    let scope = gh_workflow::expr::scope::at(&["concurrency", "cancel-in-progress"])
        .context("concurrency takes no expression")?;
    let cancels = gh_workflow::expr::canonicalize(
        &on_pull_request().to_string(),
        scope.contexts,
        scope.whole_expression,
    )
    .map_err(|error| anyhow!(error))?;

    if rendered.matches(CANCELS_NO_RUN).count() != 1 {
        bail!("expected one `cancel-in-progress: false` in the workflow's concurrency");
    }
    let delivery = rendered.replacen(
        CANCELS_NO_RUN,
        &format!("\n  cancel-in-progress: {cancels}\n"),
        1,
    );

    let before: serde_yaml::Value = serde_yaml::from_str(&rendered).context("rendered YAML")?;
    let after: serde_yaml::Value = serde_yaml::from_str(&delivery).context("delivery YAML")?;
    let unchanged_elsewhere =
        before
            .as_mapping()
            .zip(after.as_mapping())
            .is_some_and(|(before, after)| {
                before.len() == after.len()
                    && before.iter().all(|(key, value)| {
                        key.as_str() == Some("concurrency") || after.get(key) == Some(value)
                    })
            });
    if !unchanged_elsewhere
        || after["concurrency"]["group"] != before["concurrency"]["group"]
        || after["concurrency"]["cancel-in-progress"].as_str() != Some(cancels.as_str())
    {
        bail!("writing the delivery concurrency changed more than `cancel-in-progress`");
    }
    Ok(delivery)
}
