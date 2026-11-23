set -euo pipefail

# The image's build context: the binaries and the one library a service loads
# at run time. Nothing else from the checkout enters the image.
mkdir -p "$CONTEXT/bin" "$CONTEXT/pdfium-lib/linux"

for binary in $BINARIES; do
  strip -o "$CONTEXT/bin/$binary" "target/release/$binary"
done

# search_processing_service opens this library when it parses a PDF. The
# repository tracks it, and the digest is the tracked file's, so a library
# that changed is noticed here and not in a running service.
pdfium=services/search_processing_service/pdfium-lib/linux/libpdfium.so
printf '%s  %s\n' "$PDFIUM_SHA256" "$pdfium" | sha256sum --check
cp "$pdfium" "$CONTEXT/pdfium-lib/linux/libpdfium.so"

ls -l "$CONTEXT/bin"
du --summarize --human-readable "$CONTEXT"
