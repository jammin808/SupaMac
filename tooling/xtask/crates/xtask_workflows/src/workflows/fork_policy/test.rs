use std::collections::BTreeSet;

use super::*;

/// The repository boundary, as `restrict_to_upstream` spells it.
const UPSTREAM_ONLY: &str = "github.repository == 'macro-inc/macro'";

/// A workflow that keeps every rule a fork-owned workflow is held to.
const FORK_OWNED: &str = "\
on:
  push:
    branches:
      - main
permissions:
  contents: read
concurrency:
  group: supamac-fixture
jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
      - run: gh api user
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
";

/// Whether a job's condition starts with the repository boundary, as
/// `restrict_to_upstream` writes it.
fn restricted_to_upstream(job: &Value) -> bool {
    job["if"].as_str().is_some_and(|condition| {
        condition.starts_with(UPSTREAM_ONLY)
            || condition.starts_with(&format!("({UPSTREAM_ONLY}) &&"))
    })
}

#[test]
fn repository_boundary_preserves_failure_and_input_conditions() {
    let yaml = "jobs:\n  failure:\n    if: ${{ always() && failure() }}\n    runs-on: ubuntu-24.04\n  input:\n    if: inputs.deploy\n    runs-on: ubuntu-24.04\n  disabled:\n    if: 'false'\n    runs-on: ubuntu-24.04\n  default:\n    runs-on: ubuntu-24.04\n";
    let guarded: serde_yaml::Value =
        serde_yaml::from_str(&restrict_to_upstream(yaml).expect("workflow guards"))
            .expect("valid YAML");
    assert_eq!(
        guarded["jobs"]["failure"]["if"],
        "(github.repository == 'macro-inc/macro') && (always() && failure())"
    );
    assert_eq!(
        guarded["jobs"]["input"]["if"],
        "(github.repository == 'macro-inc/macro') && (inputs.deploy)"
    );
    assert_eq!(
        guarded["jobs"]["disabled"]["if"],
        "(github.repository == 'macro-inc/macro') && false"
    );
    assert_eq!(
        guarded["jobs"]["default"]["if"],
        "github.repository == 'macro-inc/macro'"
    );
}

#[test]
fn preserves_existing_job_conditions_including_status_functions() -> Result<()> {
    let yaml = restrict_to_upstream(
        "jobs:\n  deploy:\n    needs:\n      - build\n    if: ${{ always() && needs.build.result == 'success' }}\n    uses: ./workflow.yml\n  publish:\n    if: 'false'\n    runs-on: ubuntu-24.04\n  build:\n    runs-on: ubuntu-24.04\n",
    )?;
    let value: Value = serde_yaml::from_str(&yaml)?;
    assert_eq!(
        value["jobs"]["deploy"]["if"].as_str(),
        Some(
            "(github.repository == 'macro-inc/macro') && (always() && needs.build.result == 'success')"
        )
    );
    assert_eq!(
        value["jobs"]["publish"]["if"].as_str(),
        Some("(github.repository == 'macro-inc/macro') && false")
    );
    assert_eq!(value["jobs"]["build"]["if"].as_str(), Some(UPSTREAM_ONLY));
    Ok(())
}

/// A workflow as upstream's emitter lays one out: a comment ahead of it and
/// one on a line, a key after the jobs, and a script whose lines look like
/// keys of the workflow.
const UPSTREAM: &str = "\
# A notice ahead of the workflow.
name: Fixture
on:
  push:
    branches:
      - main
jobs:
  build:
    name: Build
    runs-on: ubuntu-24.04
    steps:
      - name: Run # zizmor: ignore[fixture] kept on purpose
        if: always()
        run: |
          if: true

            jobs:
          echo done
  deploy:
    needs:
      - build
    if: needs.build.result == 'success'
    runs-on: ubuntu-24.04
concurrency:
  group: fixture
  cancel-in-progress: false
";

/// A workflow here differs from upstream's by its job conditions alone, so
/// an upstream change to any other line of it merges cleanly.
#[test]
fn only_the_condition_lines_of_an_upstream_workflow_change() -> Result<()> {
    let expected = UPSTREAM
        .replace(
            "  build:\n",
            "  build:\n    if: github.repository == 'macro-inc/macro'\n",
        )
        .replace(
            "    if: needs.build.result == 'success'\n",
            "    if: (github.repository == 'macro-inc/macro') && (needs.build.result == 'success')\n",
        );
    assert_ne!(expected, UPSTREAM);
    assert_eq!(restrict_to_upstream(UPSTREAM)?, expected);
    Ok(())
}

/// A condition YAML would read differently unquoted is quoted.
#[test]
fn a_condition_yaml_would_misread_is_quoted() -> Result<()> {
    let yaml = restrict_to_upstream(
        "jobs:\n  build:\n    if: 'inputs.note != '': '''\n    runs-on: ubuntu-24.04\n",
    )?;
    assert!(
        yaml.contains("    if: '(github.repository == ''macro-inc/macro'') && "),
        "{yaml}"
    );
    let value: Value = serde_yaml::from_str(&yaml)?;
    assert_eq!(
        value["jobs"]["build"]["if"].as_str(),
        Some("(github.repository == 'macro-inc/macro') && (inputs.note != ': ')")
    );
    Ok(())
}

/// The boundary is written into the emitter's layout. Anything else is
/// refused: a job left without the boundary would run in this repository.
#[test]
fn a_layout_the_boundary_does_not_understand_is_refused() {
    for unsupported in [
        // A condition over several lines.
        "jobs:\n  build:\n    if: |-\n      always()\n      && failure()\n    runs-on: ubuntu-24.04\n",
        // A job written inline.
        "jobs:\n  build: {runs-on: ubuntu-24.04}\n",
        // A condition that is text around expressions.
        "jobs:\n  build:\n    if: ${{ inputs.a }}-${{ inputs.b }}\n    runs-on: ubuntu-24.04\n",
        // A condition that reads what a job's `if:` does not offer.
        "jobs:\n  build:\n    if: secrets.TOKEN != ''\n    runs-on: ubuntu-24.04\n",
        // Keys indented otherwise than the emitter's.
        "jobs:\n    build:\n        if: always()\n        runs-on: ubuntu-24.04\n",
        // No jobs at all.
        "name: Fixture\n",
    ] {
        assert!(
            restrict_to_upstream(unsupported).is_err(),
            "accepted:\n{unsupported}"
        );
    }
}

#[test]
fn a_fork_owned_workflow_is_refused_for_each_thing_only_upstream_has() -> Result<()> {
    assert_eq!(
        fork_owned_problems("supamac-fixture.yml", FORK_OWNED)?,
        Vec::<String>::new()
    );

    for (kept, broken, problem) in [
        (
            "runs-on: ubuntu-24.04",
            "runs-on: namespace-profile-linux-mid",
            "job `build` does not run on a GitHub-hosted runner",
        ),
        (
            "secrets.GITHUB_TOKEN",
            "secrets.DOPPLER_TOKEN",
            "it reads the secret `DOPPLER_TOKEN`; only `GITHUB_TOKEN` exists here",
        ),
        (
            "secrets.GITHUB_TOKEN",
            "SECRETS.DOPPLER_TOKEN",
            "it reads the secret `DOPPLER_TOKEN`; only `GITHUB_TOKEN` exists here",
        ),
        (
            "secrets.GITHUB_TOKEN",
            "secrets['DOPPLER_TOKEN']",
            "it reads the `secrets` context other than as `secrets.GITHUB_TOKEN`",
        ),
        (
            "secrets.GITHUB_TOKEN",
            "toJSON(secrets)",
            "it reads the `secrets` context other than as `secrets.GITHUB_TOKEN`",
        ),
        (
            "run: gh api user",
            "run: docker push ghcr.io/macro-inc/macro-agent-harness",
            "it names `macro-inc/`, which exists only upstream",
        ),
        (
            "run: gh api user",
            "run: docker push 000000000000.dkr.ecr.us-east-1.amazonaws.com/service",
            "it names `.dkr.ecr.`, which exists only upstream",
        ),
        (
            "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
            "actions/checkout@v6",
            "job `build` uses `actions/checkout@v6`, which is not pinned to a commit",
        ),
        (
            "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
            "./.github/actions/setup-rust",
            "job `build` uses `./.github/actions/setup-rust`, which is not pinned to a commit",
        ),
        (
            "  contents: read",
            "  contents: write",
            "its workflow permissions are not exactly `contents: read`",
        ),
        (
            "  push:",
            "  pull_request_target:",
            "it runs on `pull_request_target`",
        ),
        (
            "concurrency:\n  group: supamac-fixture\n",
            "",
            "it has no concurrency group",
        ),
        (
            "    timeout-minutes: 10\n",
            "",
            "job `build` has no timeout",
        ),
    ] {
        assert!(FORK_OWNED.contains(kept), "the fixture has no `{kept}`");
        assert_eq!(
            fork_owned_problems("supamac-fixture.yml", &FORK_OWNED.replace(kept, broken))?,
            [problem]
        );
    }

    assert_eq!(
        fork_owned_problems("fixture.yml", FORK_OWNED)?,
        ["its file name does not start with `supamac-`"]
    );
    Ok(())
}

#[test]
fn the_word_secrets_outside_the_context_is_not_a_read() -> Result<()> {
    let prose = FORK_OWNED
        .replace(
            "run: gh api user",
            "run: echo \"Settings, Secrets and variables (no secrets), then ${{ needs.secrets.result }}\"",
        )
        .replace("  build:\n", "  secrets:\n");

    assert_eq!(
        fork_owned_problems("supamac-fixture.yml", &prose)?,
        Vec::<String>::new()
    );
    assert_eq!(secret_reads(&prose), [SecretRead::Named("GITHUB_TOKEN")]);
    Ok(())
}

#[test]
fn a_matrix_of_runners_is_hosted_only_when_every_leg_is() -> Result<()> {
    let matrix = FORK_OWNED.replace(
        "    runs-on: ubuntu-24.04\n",
        "    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n          - runner: ubuntu-24.04\n          - runner: macos-15\n",
    );
    assert_eq!(
        fork_owned_problems("supamac-fixture.yml", &matrix)?,
        Vec::<String>::new()
    );
    assert_eq!(
        fork_owned_problems(
            "supamac-fixture.yml",
            &matrix.replace(
                "runner: macos-15",
                "runner: nscloud-macos-sequoia-arm64-6x14"
            )
        )?,
        ["job `build` does not run on a GitHub-hosted runner"]
    );
    Ok(())
}

/// Both directions of the boundary, on what the generator writes: a
/// fork-owned workflow runs here and stays on the fork's own resources, and
/// every other workflow runs nowhere but upstream.
#[test]
fn every_generated_workflow_is_on_its_side_of_the_repository_boundary() -> Result<()> {
    let mut fork_owned = 0;
    for workflow in crate::workflows::WORKFLOWS {
        let yaml = crate::workflows::render(workflow)?;
        let value: Value = serde_yaml::from_str(&yaml)?;
        let jobs = value["jobs"].as_mapping().context("jobs")?;

        if is_fork_owned(workflow) {
            fork_owned += 1;
            assert_eq!(
                fork_owned_problems(workflow.file_name, &yaml)?,
                Vec::<String>::new(),
                "{}",
                workflow.file_name
            );
            for (id, job) in jobs {
                assert!(
                    !restricted_to_upstream(job),
                    "{} job {id:?} is switched off in this repository",
                    workflow.file_name
                );
            }
        } else {
            assert!(
                !workflow.file_name.starts_with(FORK_FILE_PREFIX),
                "{} is named as fork-owned and generated from `{}`, which is not",
                workflow.file_name,
                workflow.slug
            );
            for (id, job) in jobs {
                assert!(
                    restricted_to_upstream(job),
                    "{} job {id:?} can run outside upstream",
                    workflow.file_name
                );
            }
        }
    }
    assert!(fork_owned > 0, "no generated workflow is fork-owned");
    Ok(())
}

/// The same boundary on what is checked in, so a workflow file that was
/// merged or edited without regenerating fails here. A `supamac-` file is one
/// the generator wrote for a fork-owned workflow; any other file is
/// restricted to upstream.
#[test]
fn every_checked_in_workflow_is_on_its_side_of_the_repository_boundary() -> Result<()> {
    let fork_owned: BTreeSet<&str> = crate::workflows::WORKFLOWS
        .iter()
        .filter(|workflow| is_fork_owned(workflow))
        .map(|workflow| workflow.file_name)
        .collect();

    let directory = xtask_paths::repo_root().join(".github/workflows");
    for entry in std::fs::read_dir(directory).context("workflows directory")? {
        let path = entry.context("workflow entry")?.path();
        if !matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("yml" | "yaml")
        ) {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .context("workflow file name")?;
        let yaml = std::fs::read_to_string(&path).context("workflow source")?;
        let workflow: Value = serde_yaml::from_str(&yaml).context("valid workflow")?;
        let jobs = workflow["jobs"].as_mapping().context("workflow jobs")?;

        if name.starts_with(FORK_FILE_PREFIX) {
            assert!(
                fork_owned.contains(name),
                "{name} is named as fork-owned, and no fork-owned workflow generates it"
            );
            assert_eq!(
                fork_owned_problems(name, &yaml)?,
                Vec::<String>::new(),
                "{name}"
            );
            for (id, job) in jobs {
                assert!(
                    !restricted_to_upstream(job),
                    "{name} job {id:?} is switched off in this repository"
                );
            }
        } else {
            for (id, job) in jobs {
                assert!(
                    restricted_to_upstream(job),
                    "{name} job {id:?} is not guarded"
                );
            }
        }
    }
    Ok(())
}
