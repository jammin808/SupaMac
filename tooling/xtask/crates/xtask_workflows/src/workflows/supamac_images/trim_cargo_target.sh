set -euo pipefail

# A build that stopped before it compiled anything left nothing to trim.
test -d target/release/deps || exit 0

# A fresh checkout's sources are newer than any kept build, so cargo
# recompiles the workspace's own crates and links every binary again on each
# run: only third-party crates are reused. The linked executables are the
# largest files no later run reads, so they are not kept.
find target/release -maxdepth 1 -type f -executable -delete
find target/release/deps -maxdepth 1 -type f -executable ! -name '*.so' -delete
du --summarize --human-readable target/release
