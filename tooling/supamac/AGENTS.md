# SupaMac maintenance tools

These Bun TypeScript scripts check this fork's self-hosting prerequisites and
all tracked JavaScript dependency lockfiles. They never deploy or print secrets.

## Checks

- `bun test tooling/supamac`
- `bun tooling/supamac/audit-dependencies.ts` (network access required)
- `bun tooling/supamac/doctor.ts` (reports missing runtime prerequisites)

Keep scanner failures fatal. Do not baseline away inherited high/critical
advisories to make CI green. Report unavailable scanners separately from a clean scan.
