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
