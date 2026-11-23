use gh_workflow::{Event, Job, Push};

use super::*;

/// The fork's jobs install this toolchain by name and set it as
/// `RUSTUP_TOOLCHAIN`, which makes rustup ignore `rust-toolchain.toml`. The
/// two must name the same release, or CI compiles with another compiler than
/// every other build of the repository.
#[test]
fn pinned_toolchain_is_the_repository_toolchain() {
    let toolchain = std::fs::read_to_string(xtask_paths::repo_root().join("rust-toolchain.toml"))
        .expect("rust-toolchain.toml");
    assert!(
        toolchain.contains(&format!("channel = \"{RUST_TOOLCHAIN}\"")),
        "rust-toolchain.toml does not name {RUST_TOOLCHAIN}"
    );
}

/// A run that publishes is never cancelled half way: only a pull request's
/// superseded run is. The job's own concurrency is not the workflow's and
/// stays as the job set it.
#[test]
fn a_delivery_workflow_cancels_only_a_superseded_pull_request_run() {
    let workflow = Workflow::new("Fixture")
        .on(Event::default().push(Push::default().add_branch("main")))
        .add_job(
            "build",
            Job::default()
                .runs_on(RUNNER)
                .timeout_minutes(5u32)
                .concurrency(Concurrency::new("fixture").cancel_in_progress(false))
                .add_step(Step::new("Build").run("true")),
        );

    let yaml = render_delivery(workflow).expect("render");
    let value: serde_yaml::Value = serde_yaml::from_str(&yaml).expect("valid YAML");
    assert_eq!(
        value["concurrency"]["group"],
        "supamac-${{ github.workflow }}-${{ github.ref }}"
    );
    assert_eq!(
        value["concurrency"]["cancel-in-progress"],
        "${{ github.event_name == 'pull_request' }}"
    );
    assert_eq!(
        value["jobs"]["build"]["concurrency"]["cancel-in-progress"],
        false
    );
}
