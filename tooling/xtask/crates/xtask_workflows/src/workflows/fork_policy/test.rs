use super::*;

#[test]
fn repository_boundary_preserves_failure_and_input_conditions() {
    let yaml = "jobs:\n  failure:\n    if: ${{ always() && failure() }}\n  input:\n    if: inputs.deploy\n  disabled:\n    if: false\n  default: {}\n";
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
fn checked_in_jobs_cannot_use_upstream_infrastructure_from_a_fork() {
    let directory = xtask_paths::repo_root().join(".github/workflows");
    for entry in std::fs::read_dir(directory).expect("workflows directory") {
        let path = entry.expect("workflow entry").path();
        if path
            .file_name()
            .is_some_and(|name| name == "supamac-ci.yml")
        {
            continue;
        }
        if !matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("yml" | "yaml")
        ) {
            continue;
        }
        let yaml = std::fs::read_to_string(&path).expect("workflow source");
        let workflow: serde_yaml::Value = serde_yaml::from_str(&yaml).expect("valid workflow");
        for (name, job) in workflow["jobs"].as_mapping().expect("workflow jobs") {
            assert!(
                job["if"]
                    .as_str()
                    .is_some_and(|condition| condition.starts_with(UPSTREAM_ONLY)
                        || condition.starts_with(&format!("({UPSTREAM_ONLY}) &&"))),
                "{} job {name:?} is not guarded",
                path.display()
            );
        }
    }
}

#[test]
fn preserves_existing_job_conditions_including_status_functions() -> Result<()> {
    let yaml = restrict_to_upstream(
        "jobs:\n  deploy:\n    if: ${{ always() && needs.build.result == 'success' }}\n    uses: ./workflow.yml\n  publish:\n    if: false\n    runs-on: ubuntu-24.04\n  build:\n    runs-on: ubuntu-24.04\n",
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

#[test]
fn every_generated_upstream_job_has_the_repository_boundary() -> Result<()> {
    for workflow in crate::workflows::WORKFLOWS {
        let yaml = crate::workflows::render(workflow)?;
        let value: Value = serde_yaml::from_str(&yaml)?;
        let jobs = value["jobs"].as_mapping().context("jobs")?;
        for (id, job) in jobs {
            if workflow.slug != "supamac_ci" {
                assert!(
                    job["if"]
                        .as_str()
                        .is_some_and(|s| s.contains(UPSTREAM_ONLY)),
                    "{} job {id:?} can run outside upstream",
                    workflow.file_name
                );
            }
        }
    }
    Ok(())
}
