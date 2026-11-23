set -euo pipefail

# The digest names exactly what this run pushed. A deployment pins it.
test -n "$DIGEST"
{
  echo "### $IMAGE"
  echo
  echo '```'
  echo "$IMAGE@$DIGEST"
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
