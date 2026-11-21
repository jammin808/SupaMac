set -euo pipefail

# Runs inside the image as its own user, with no network. The binaries were
# linked on the runner, so this is where a shared library the image lacks, or
# a C library older than the runner's, shows up.
docker run --rm --interactive --network none --entrypoint sh "$IMAGE" -eu -s -- $BINARIES <<'CHECK'
test "$(id -u)" = 10001

for binary in "$@"; do
  test -x "/app/bin/$binary"
  if ldd "/app/bin/$binary" 2>&1 | grep 'not found'; then
    echo "$binary needs a shared library this image does not have" >&2
    exit 1
  fi
done

pdfium=/app/pdfium-lib/linux/libpdfium.so
test -r "$pdfium"
if ldd "$pdfium" 2>&1 | grep 'not found'; then
  echo "libpdfium.so needs a shared library this image does not have" >&2
  exit 1
fi

"$DENO_BINARY" --version
test -x "$(git --exec-path)/git-http-backend"
test -w /data/agent-git
echo "the image holds $# binaries and what they load"
CHECK
