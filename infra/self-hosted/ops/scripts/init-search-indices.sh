#!/bin/sh
# Creates the search indices and aliases with the repository's own script,
# which holds the mappings (infra/stacks/opensearch/helpers) and leaves an
# index that exists alone.
set -eu

cd /opt/supamac/search-indices
ENVIRONMENT=local DRY_RUN=false exec bun run scripts/create_indices.ts
