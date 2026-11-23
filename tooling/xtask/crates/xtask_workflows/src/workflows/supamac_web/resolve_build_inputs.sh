set -euo pipefail

# The folder the bundle is served from and the backend it calls are this
# deployment's own, kept in repository variables. A pull request publishes
# nothing and may run without them (a fork's pull request never sees them), so
# it builds for placeholders. Any other run may publish, so without them it
# stops here rather than build for the placeholders.
base_path="$CONFIGURED_BASE_PATH"
backend_origin="$CONFIGURED_BACKEND_ORIGIN"

if [ "$GITHUB_EVENT_NAME" = pull_request ]; then
  base_path="${base_path:-/workspace}"
  backend_origin="${backend_origin:-https://api.example.com}"
elif [ -z "$base_path" ] || [ -z "$backend_origin" ]; then
  echo "::error title=Repository variables are not set::Set SUPAMAC_WEB_BASE_PATH (the folder, such as /workspace) and SUPAMAC_BACKEND_ORIGIN (the backend's https origin, with no path) under Settings, Secrets and variables, Actions, Variables. Nothing was built or published."
  exit 1
fi

# The rules the build itself applies, so a value it would refuse stops the run
# here. Checked before anything is written to the step's outputs, which take
# one value per line. The build accepts an origin only in the form a browser
# reports it in: the host in lower case and no default port. A letter range
# means ASCII letters in the C locale alone.
LC_ALL=C
if [[ ! "$base_path" =~ ^(/[A-Za-z0-9_-]+)+$ ]]; then
  echo "::error title=SUPAMAC_WEB_BASE_PATH is malformed::It must look like /workspace or /team/app."
  exit 1
fi
if [[ ! "$backend_origin" =~ ^https://[a-z0-9.-]+(:[1-9][0-9]*)?$ ]] || [[ "$backend_origin" = *:443 ]]; then
  echo "::error title=SUPAMAC_BACKEND_ORIGIN is malformed::It must be an https origin in lower case, with no path and without the port 443, such as https://api.example.com."
  exit 1
fi

# Outputs of this step, not the environment of the job: only the steps that
# build and package the bundle are given the two values. The unit tests cover
# the hosted and the local service addresses as well, and fail with a backend
# origin in their environment.
{
  echo "base_path=$base_path"
  echo "backend_origin=$backend_origin"
} >> "$GITHUB_OUTPUT"
