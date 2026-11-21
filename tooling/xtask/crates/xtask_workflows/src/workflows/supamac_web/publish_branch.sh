set -euo pipefail

# Makes the packaged folder the only commit of the branch the host deploys
# from. The commit is made in a repository of its own, which has no other
# branch or tag, and the push names that one branch, so no other ref of the
# remote can change.

test -f "$SITE/index.html"
test -f "$SITE/.htaccess"

# The folder was packaged by another job. It is published only if it was
# packaged for the folder and the backend this repository is configured for.
packaged_base_path="$(jq --raw-output .basePath "$MANIFEST")"
packaged_backend_origin="$(jq --raw-output .backendOrigin "$MANIFEST")"
if [ -z "$EXPECTED_BASE_PATH" ] || [ "$packaged_base_path" != "$EXPECTED_BASE_PATH" ] \
  || [ -z "$EXPECTED_BACKEND_ORIGIN" ] || [ "$packaged_backend_origin" != "$EXPECTED_BACKEND_ORIGIN" ]; then
  echo "::error title=Not published::The bundle was packaged for $packaged_base_path and $packaged_backend_origin, which are not the values of SUPAMAC_WEB_BASE_PATH and SUPAMAC_BACKEND_ORIGIN."
  exit 1
fi

cd "$SITE"
git init --quiet --initial-branch "$BRANCH"
git add --all --force
git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit --quiet --message "Web bundle built from $SOURCE_SHA"

# The token reaches git through a credential helper that reads it from the
# environment, so it is in no command line and no file.
git -c credential.helper= \
  -c credential.helper='!f() { test "$1" = get && printf "username=x-access-token\npassword=%s\n" "$GITHUB_TOKEN"; }; f' \
  push --force "$REMOTE" "HEAD:refs/heads/$BRANCH"

{
  echo "### Published"
  echo
  echo "Branch \`$BRANCH\` now holds commit \`$(git rev-parse HEAD)\`, the bundle built from \`$SOURCE_SHA\`."
} >> "$GITHUB_STEP_SUMMARY"
