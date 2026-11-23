use std::process::Command;

#[test]
fn rendered_scanner_checksums_verify_files_in_paths_with_spaces() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(&super::render().expect("render CI")).expect("valid YAML");
    let temporary = tempfile::Builder::new()
        .prefix("scanner paths ")
        .tempdir()
        .expect("temporary scanner directory");
    for name in ["cargo-audit.tgz", "gitleaks.tgz"] {
        std::fs::write(temporary.path().join(name), b"checksum regression fixture")
            .expect("archive fixture");
    }
    let digest = Command::new("sha256sum")
        .arg(temporary.path().join("cargo-audit.tgz"))
        .output()
        .expect("compute fixture digest");
    assert!(digest.status.success());
    let digest = String::from_utf8(digest.stdout).expect("digest text");
    let digest = digest.split_whitespace().next().expect("digest field");

    let mut verified = 0;
    for job in ["dependencies", "secrets"] {
        for step in workflow["jobs"][job]["steps"]
            .as_sequence()
            .expect("job steps")
        {
            let Some(script) = step["run"].as_str() else {
                continue;
            };
            for line in script
                .lines()
                .filter(|line| line.contains("sha256sum --check"))
            {
                let expected = line
                    .split('\'')
                    .nth(1)
                    .and_then(|format| format.split_whitespace().next())
                    .expect("expected digest in printf format");
                let verification = line.replace(expected, digest);
                let output = Command::new("bash")
                    .args(["-euo", "pipefail", "-c", &verification])
                    .env("RUNNER_TEMP", temporary.path())
                    .output()
                    .expect("verify generated checksum command");
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                verified += 1;
            }
        }
    }
    assert_eq!(verified, 2);
}

/// CodeQL analyses each language in a job of its own, under the check name a
/// matrix leg would have and with its own time limit. Those jobs alone hold
/// more than the workflow's read-only token: they write security events.
#[test]
fn each_codeql_language_has_its_own_job_and_time_limit() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(&super::render().expect("render CI")).expect("valid YAML");
    let security_events: serde_yaml::Value =
        serde_yaml::from_str("contents: read\nsecurity-events: write\n").expect("permissions");

    let mut analysed = Vec::new();
    for (id, job) in workflow["jobs"].as_mapping().expect("jobs") {
        let id = id.as_str().expect("job id");
        let Some(language) = id.strip_prefix("codeql-") else {
            assert!(
                job.get("permissions").is_none(),
                "{id} asks for a token of its own"
            );
            continue;
        };

        assert_eq!(
            job["name"].as_str(),
            Some(format!("CodeQL ({language})").as_str())
        );
        assert_eq!(job["permissions"], security_events, "{id}");
        let step = |action: &str| {
            job["steps"]
                .as_sequence()
                .expect("steps")
                .iter()
                .find(|step| {
                    step["uses"]
                        .as_str()
                        .is_some_and(|uses| uses.starts_with(action))
                })
                .unwrap_or_else(|| panic!("{id} has no {action} step"))
        };
        assert_eq!(
            step("github/codeql-action/init@")["with"]["languages"].as_str(),
            Some(language)
        );
        assert_eq!(
            step("github/codeql-action/analyze@")["with"]["category"].as_str(),
            Some(format!("/language:{language}").as_str())
        );
        analysed.push((language.to_owned(), job["timeout-minutes"].as_u64()));
    }

    assert_eq!(
        analysed,
        [
            ("javascript-typescript".to_owned(), Some(45)),
            ("rust".to_owned(), Some(120)),
        ]
    );
}

/// A change to the generator or to the model it renders through rewrites
/// every workflow, so the fork's CI lints and tests both crates and checks
/// that what is checked in is what they generate.
#[test]
fn the_tooling_job_checks_the_generator_and_its_model() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(&super::render().expect("render CI")).expect("valid YAML");
    let script = workflow["jobs"]["tooling"]["steps"]
        .as_sequence()
        .expect("steps")
        .iter()
        .find(|step| step["name"] == "Check and test fork tooling")
        .expect("the tooling check step")["run"]
        .as_str()
        .expect("script");

    for command in [
        "cargo clippy --locked -p xtask_workflows -p gh_workflow -- -D warnings",
        "cargo test --locked -p xtask_workflows -p gh_workflow",
        "cargo x workflows --check",
    ] {
        assert!(script.lines().any(|line| line == command), "{command}");
    }
}
