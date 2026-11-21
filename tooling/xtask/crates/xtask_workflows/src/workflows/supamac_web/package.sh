set -euo pipefail

# The packaging tool refuses a bundle built for another folder, and one in
# which no script addresses the backend: such a bundle calls the upstream
# hosts and loads their analytics. Its refusal fails this job. That is all it
# checks: it does not search the scripts for upstream hosts.
arguments=(
  --dist apps/web/dist
  --base-path "$MACRO_APP_BASE_PATH"
  --backend-origin "$VITE_BACKEND_ORIGIN"
  --out "$SITE"
)
if [ "$ENFORCE_CSP" = true ]; then
  arguments+=(--enforce-csp)
fi
if [ "$OMIT_VIDEOS" = true ]; then
  arguments+=(--omit-videos)
fi

bun run supamac:package-web "${arguments[@]}" | tee "$RUNNER_TEMP/package-web.txt"

{
  echo "### Web bundle"
  echo
  echo "Built for the folder \`$MACRO_APP_BASE_PATH\` and the backend \`$VITE_BACKEND_ORIGIN\`."
  echo
  echo '```'
  cat "$RUNNER_TEMP/package-web.txt"
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
