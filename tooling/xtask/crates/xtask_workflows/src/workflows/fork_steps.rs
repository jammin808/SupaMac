//! Settings and steps shared by the workflows this fork owns (`supamac_*`).
//! They run on GitHub-hosted runners with pinned tools and the run's own
//! token; `fork_policy::check_fork_owned` holds each of them to that.

use anyhow::Result;
use gh_workflow::{Run, Step, Use};

use crate::workflows::yaml_fragment;

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

/// A pull request run: it builds and tests, and publishes nothing.
pub const ON_PULL_REQUEST: &str = "github.event_name == 'pull_request'";

/// A push to `main` or a manual run, which may publish.
pub const NOT_ON_PULL_REQUEST: &str = "github.event_name != 'pull_request'";

/// actions/cache v5.0.5, the release upstream's deploy build already pins.
pub const ACTIONS_CACHE: &str = "27d5ce7f107fe9357f9df03efb73ab90386fccae";

/// actions/upload-artifact v7.0.2, resolved 2026-11-21.
pub const UPLOAD_ARTIFACT: &str = "cf430e030ddbb5b0abf93d22962f4752f3646cd9";

/// actions/download-artifact v8.0.2, resolved 2026-11-21.
pub const DOWNLOAD_ARTIFACT: &str = "9000827ccba6bdab643e8b6fd33ac0654aef8333";

/// Bun at the version the fork's lockfiles are written by.
pub fn setup_bun() -> Step<Use> {
    Step::new("Setup Bun for current lockfile formats")
        .uses(
            "oven-sh",
            "setup-bun",
            "0c5077e51419868618aeaa5fe8019c62421857d6",
        ) // v2.2.0
        .add_with(("bun-version", "1.4.5"))
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

/// The `concurrency` block of a workflow that publishes. Runs of one workflow
/// on one ref never overlap. A newer pull request run cancels the older one.
/// On any other ref the run in progress finishes, because it may be half way
/// through publishing, and of the runs that queue behind it GitHub keeps the
/// newest. gh-workflow models `cancel-in-progress` as a plain boolean, so the
/// block is written as YAML.
pub fn delivery_concurrency() -> Result<serde_yaml::Value> {
    yaml_fragment(
        "group: supamac-${{ github.workflow }}-${{ github.ref }}\ncancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
    )
}
