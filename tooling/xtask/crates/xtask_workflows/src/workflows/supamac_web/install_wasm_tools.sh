set -euo pipefail

# The tools `just build-wasm` runs, each at the release the build was measured
# with and each checked against its digest before it is unpacked. wasm-pack
# would download wasm-bindgen and wasm-opt itself, unchecked; it uses the ones
# on the path instead. It takes wasm-bindgen from the path only at the release
# Cargo.lock names, so that pin moves with the lockfile (a test holds the two
# equal).
tools="$RUNNER_TEMP/supamac-tools"
mkdir -p "$tools"

curl -fsSL --retry 3 https://github.com/casey/just/releases/download/1.59.0/just-1.59.0-x86_64-unknown-linux-musl.tar.gz -o "$RUNNER_TEMP/just.tar.gz"
printf '409044617b6f06517c1035e55ca38c8c856ff8b650e41bc2aa1ef82d5903a23e  %s\n' "$RUNNER_TEMP/just.tar.gz" | sha256sum --check
tar -xzf "$RUNNER_TEMP/just.tar.gz" -C "$tools" just

curl -fsSL --retry 3 https://github.com/rustwasm/wasm-pack/releases/download/v0.15.1/wasm-pack-v0.15.1-x86_64-unknown-linux-musl.tar.gz -o "$RUNNER_TEMP/wasm-pack.tar.gz"
printf '410101009739b9d01c7d5affaaad6e9c9a24b4cba6791a4805db8e89b9bf7af2  %s\n' "$RUNNER_TEMP/wasm-pack.tar.gz" | sha256sum --check
tar -xzf "$RUNNER_TEMP/wasm-pack.tar.gz" -C "$tools" --strip-components=1 wasm-pack-v0.15.1-x86_64-unknown-linux-musl/wasm-pack

curl -fsSL --retry 3 https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.126/wasm-bindgen-0.2.126-x86_64-unknown-linux-musl.tar.gz -o "$RUNNER_TEMP/wasm-bindgen.tar.gz"
printf '064948d58e2d6c0a745216477a639ba696216d6309aaa902939d1b865b1d869d  %s\n' "$RUNNER_TEMP/wasm-bindgen.tar.gz" | sha256sum --check
tar -xzf "$RUNNER_TEMP/wasm-bindgen.tar.gz" -C "$tools" --strip-components=1 wasm-bindgen-0.2.126-x86_64-unknown-linux-musl/wasm-bindgen

curl -fsSL --retry 3 https://github.com/WebAssembly/binaryen/releases/download/version_130/binaryen-version_130-x86_64-linux.tar.gz -o "$RUNNER_TEMP/binaryen.tar.gz"
printf '0a18362361ad05465118cd8eeb72edaeec89de6894bc283576ef4e07aa3babcc  %s\n' "$RUNNER_TEMP/binaryen.tar.gz" | sha256sum --check
tar -xzf "$RUNNER_TEMP/binaryen.tar.gz" -C "$tools" --strip-components=2 binaryen-version_130/bin/wasm-opt

echo "$tools" >> "$GITHUB_PATH"
