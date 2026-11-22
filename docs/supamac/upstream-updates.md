# Taking a new upstream snapshot

How this fork moves to a newer state of upstream. The recorded state is
`.supamac/upstream.json`: the upstream repository, the revision last taken
and the day it was taken.

## How upstream is held

The fork's history holds upstream as **snapshot commits** and none of
upstream's own history. A snapshot commit's tree is upstream's tree at one
revision, byte for byte, and its parent is the snapshot commit before it:

| Snapshot commit | Upstream revision | Taken |
| --- | --- | --- |
| `f876dc04` | `f8a38d2b` | 2026-11-19 |
| `524aa186` | `e0ece1d1` | 2026-11-21 |

Each snapshot commit after the first is merged into the fork's branch with an
ordinary merge commit. The previous snapshot is then an ancestor of both
sides, so git finds it as the merge base by itself, and the merge is "what
upstream changed since the last snapshot" against "what the fork changed".

Find the newest snapshot commit in a checkout of the fork's branch, and check
what was found:

```sh
previous=$(git log --no-merges --topo-order -1 --format=%H \
  --grep='^chore: import .*upstream source snapshot')
git log -1 --abbrev=8 --format='%h %s' "$previous"
git ls-tree "$previous" .supamac
```

The second command must print the hash in the table's last row, and the
third must print nothing: a snapshot holds none of the fork's files. The
search reads every line of every commit message, so a commit of the fork's
that repeats a snapshot's subject answers it too. `--no-merges` leaves out
the merge commit of a pull request, which carries the request's title on a
line of its own; `--topo-order` puts a snapshot before its parent whatever
their dates. If another hash is printed, one of two things happened, and
`git merge-base --is-ancestor <the table's hash> HEAD` tells them apart:

- It succeeds: the search found a commit of the fork's. Set `previous` to
  the table's hash by hand and run the two checks again.
- It fails: the last snapshot never reached the branch, because its pull
  request was squashed or rebased. See [the pull request](#the-pull-request).

## The update

1. **Fetch upstream without its history.** The date is a few days before
   `imported_at`, so that the fetch reaches back to the recorded revision
   and `git log <recorded revision>..FETCH_HEAD` lists what is new:

   ```sh
   git fetch --filter=blob:none --shallow-since=<date> <upstream url> main
   ```

2. **Create the snapshot commit.** It changes no branch. Its parent is
   `previous` as found [above](#how-upstream-is-held), and both checks on it
   must hold first; if one does not, stop. A snapshot whose parent is a
   commit of the fork's merges without a conflict and takes the fork's own
   files and edits out of the tree.

   ```sh
   snapshot=$(git commit-tree "FETCH_HEAD^{tree}" -p "$previous" \
     -m "chore: import upstream source snapshot $(git rev-parse --short=8 FETCH_HEAD)" \
     -m "Upstream-Commit: $(git rev-parse FETCH_HEAD)")
   ```

3. **Merge it** on a branch of its own, with a merge commit:
   `git merge --no-ff "$snapshot"`. Resolve what is written by hand. Do not
   resolve a generated file: take either side and regenerate it in the next
   step. Every workflow under `.github/workflows` is generated.

4. **Regenerate what is generated** and commit the results with the merge:
   - `cargo x workflows`: every workflow and composite action, `checks.lock`
     and the action bindings. This is also what puts the fork's repository
     guard on the workflows upstream added or changed.
   - `cargo x deps` (`just hakari` runs the same): `crates/workspace-hack`
     and `.github/workspace-dep-closures.json`.
   - `cargo x kafka-topics`: `.github/kafka-cluster-topics.json`.
   - The two hashes in `nix-support/node_modules-hashes.json`. Neither side
     of the merge has the right value. The fork's Nix dependency job measures
     them on Linux and on macOS; take them from its run, never from a guess.

5. **Follow the developer stack into `infra/self-hosted`.** The stack copies
   the developer stack's resources and settings by hand
   ([its guide](../../infra/self-hosted/AGENTS.md) has the recipes). Read
   what upstream changed in `tooling/xtask/crates/xtask_local` (queues,
   buckets, tables, variables, routes), `crates/macro_queues`,
   `.github/kafka-cluster-topics.json` and the web client's `servers.ts`,
   and for each change either make it in the stack or write down in its
   README why not.

6. **Decide every new feature switch.** List the flags upstream added and
   say for each whether this deployment wants it. Then look for the ones
   that ask nobody; see the second check below.

7. **Run the scans and the rehearsal again**: the dependency, advisory and
   secret scans of [security status](security-status.md), and the stack
   started from the new images on a machine that is not the server, with the
   migrations applied to a copy of real data. Counts in that page change
   only from a scanner's completed output.

8. **Update the records**: `.supamac/upstream.json`, the header of
   [security status](security-status.md), the pin in the root `README.md`,
   the table above, what the stack's README says was checked on which
   snapshot, and the upgrade notes for this snapshot in
   [deployment](deployment.md#upgrading).

## The pull request

Merge it with a **merge commit**. A squash or a rebase leaves the snapshot
commit out of the branch's history, and the next update then has no merge
base but the snapshot before: everything upstream changed in between
conflicts with itself.

If that happened, put the snapshot back into the history before the next
update. The tree is the one of the recorded revision; if the snapshot commit
still exists, on the closed pull request's branch for one, use it as `base`
and skip the first two commands:

```sh
git fetch --filter=blob:none --depth=1 <upstream url> <recorded revision>
base=$(git commit-tree "FETCH_HEAD^{tree}" \
  -p <the snapshot commit in the table's row before the last> \
  -m "chore: import upstream source snapshot <recorded revision, short>" \
  -m "Upstream-Commit: <recorded revision>")
git merge -s ours -m "merge: record upstream snapshot <short> as merged" "$base"
```

The parent is read from the table and not searched for: the squashed commit
is a commit of the fork's, and it may carry the snapshot's subject. A `base`
made this way is a new commit, so write its hash into the table's last row
in place of the lost one.

`-s ours` changes no file: it records that the branch already holds that
snapshot, which is true. The next update then starts at step 1, and its
merge finds `base`. This was tried on a scratch repository, not on this one.

## Checks that found something in the update of 2026-11-21

Run all three on every update.

- **Workflows without the fork's guard.** Upstream's workflows arrive as
  upstream runs them: on its own runners, with its secrets, on pushes and
  schedules. `cargo x workflows --check` and
  `cargo test -p xtask_workflows -p gh_workflow` fail while any checked-in
  workflow is on the wrong side of the repository boundary. Regenerate; do
  not edit the YAML.
- **Features switched on by `ENVIRONMENT=local`.** The self-hosted stack
  runs every service with it, and upstream uses it to mean "a developer's
  machine, turn it on". Each line this prints is a behaviour to read:

  ```sh
  git diff "$previous" "$snapshot" -- crates services |
    grep -E '^\+.*(Environment::Local|POSTHOG|PosthogApiKey)'
  ```

  This update's were agents sending notifications and contact lists being
  written. A new reader of the PostHog key matters for another reason: a
  service given the key without the stack's unreachable host would talk to
  the hosted endpoint.
- **Queues the stack lacks.** `bun test` in `infra/self-hosted/ops/src`,
  from the checkout, holds the stack's queues and their attributes to the
  developer stack's catalogue. Run it by hand: the ops image's build runs
  the same tests without the catalogue and skips this comparison. A worker
  whose queue is missing fails quietly or retries without end; this update's
  would have stopped the hourly mailbox maintenance.
