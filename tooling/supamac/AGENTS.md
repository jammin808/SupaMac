# SupaMac maintenance tools

These Bun TypeScript scripts check this fork's self-hosting prerequisites and
all tracked JavaScript dependency lockfiles, and package a built web bundle for
static hosting. They never deploy or print secrets.

`package-web.ts` writes the `.htaccess` and Content Security Policy described
in [static publishing](../../docs/supamac/static-publishing.md). A source
added to the policy carries its reason in a comment, and that guide's table of
third-party hosts and its lists of what was and was not verified change with
it.

## Checks

- `bun test tooling/supamac`
- `bun tooling/supamac/audit-dependencies.ts` (network access required)
- `bun tooling/supamac/doctor.ts` (reports missing runtime prerequisites)
- `bun tooling/supamac/package-web.ts` with no arguments prints its usage; a
  real run needs a web bundle built for the same folder and backend

Keep scanner failures fatal. Do not baseline away inherited high/critical
advisories to make CI green. Report unavailable scanners separately from a clean scan.
