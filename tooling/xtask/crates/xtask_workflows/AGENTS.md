# xtask_workflows

## What it is

`cargo x workflows`: every GitHub Actions workflow and composite action in
`.github/`, written in Rust on the vendored `../gh_workflow` model and rendered
to YAML, plus the files derived from them (`checks.lock`,
`.github/actionlint.yaml`, the typed bindings in `src/workflows/actions.rs`).

## Start here

- `src/workflows.rs`: the `WORKFLOWS` list, generate and `--check`.
- `src/workflows/steps.rs`, `vars.rs`, `runners.rs`: shared steps, secrets and
  vars, runner labels.
- `src/workflows/composite.rs`: our composite actions (`ACTIONS`).
- `src/actions.rs`: `actions.lock`, `actions fetch`, and the generator of
  `src/workflows/actions.rs` (`<Owner><Repo>`, `Local<Name>`, `Call<Name>`).

## Recipes

- Add a workflow: a module in `src/workflows/`, an entry in `WORKFLOWS`, then
  `cargo x workflows`.
- Add a third-party action: a line in `actions.lock`, then
  `cargo x workflows actions fetch` and `cargo x workflows`.
- Change an action's or reusable workflow's inputs: run `cargo x workflows`
  once before callers use the new setter (bindings come from the rendered files).

## Checks

- `cargo test -p xtask_workflows -p gh_workflow`
- `cargo x workflows --check`; `cargo x workflows diff --base <rev>` for a change
  meant to keep behaviour (prints `no semantic changes`).
- `nix develop .#workflow-lint -c sh -c 'actionlint && zizmor --offline .github'`

## Gotchas

- Never edit `src/workflows/actions.rs` or anything under `.github/` it
  generates; `--check` fails.
- Long shell scripts go in `.sh` files via `include_str!`: rustfmt re-indents
  `\`-continued lines inside string literals on every run.
- `checks.lock` diffs are check renames GitHub or our gate scripts will notice.

## Related

- Rules: `.agents/rules/infra/github-workflows.md`

## This fork

- `src/workflows/fork_policy.rs`: the repository boundary. `render` in
  `workflows.rs` calls its `apply` once: a `supamac_*` workflow is held to the
  fork's rules, every other workflow's jobs are restricted to upstream.
- `src/workflows/fork_steps.rs` and `supamac_*.rs`: the fork's own workflows
  and what they share. Everything else in this crate is upstream's.
- Rules: the "In this fork" section of
  `.agents/rules/infra/github-workflows.md`.
- Regenerate after an upstream merge. `src/workflows/actions.rs` is generated,
  both sides change it, and the fork's modules need bindings upstream's copy
  lacks, so the generator may not build:
  1. Merge `actions.lock` by hand: upstream's lines, the fork's block, the
     newer commit where both moved a line. Where `src/workflows/actions.rs` or
     `actions/*.yml` conflict, take upstream's side.
  2. If `cargo x workflows actions fetch` doesn't build, take the `supamac_*`
     `mod` lines and `WORKFLOWS` entries out of `workflows.rs` (`fork_steps`
     too if it is what fails) and move `.github/workflows/supamac-*.yml` out
     of that directory: the generator refuses a workflow it doesn't write.
     Leave `fork_policy` in, so no upstream workflow is written unguarded.
  3. Run `cargo x workflows actions fetch`, then `cargo x workflows`: it
     writes bindings for every locked action, used or not.
  4. Put the lines and the files back (a fork workflow's `paths` name its own
     file, which must exist), run `cargo x workflows` again, then `--check`.
- Moving a pin takes `cargo x workflows` twice: the bindings hold the commit,
  so the first run rewrites them and the second writes the workflows.
