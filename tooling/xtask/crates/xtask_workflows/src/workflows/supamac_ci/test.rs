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
