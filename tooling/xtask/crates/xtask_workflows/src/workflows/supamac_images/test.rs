use std::collections::BTreeSet;
use std::process::Command;

use super::*;

/// Every job that pushes, by id. No other job may reach the registry.
const PUBLISHING_JOBS: [&str; 4] = [
    "services-image",
    "sync-service-image",
    "workers-image",
    "ops-image",
];

/// What a job that pushes holds, and nothing wider.
const PUBLISH_PERMISSIONS: &str =
    "contents: read\npackages: write\nid-token: write\nattestations: write\n";

const ON_PULL_REQUEST: &str = "github.event_name == 'pull_request'";
const NOT_ON_PULL_REQUEST: &str = "github.event_name != 'pull_request'";

/// The build is the workflow's longest step, so a renamed binary must fail
/// here and not an hour into a run. A feature flag must never appear: cargo
/// would unify it into every service of the invocation.
#[test]
fn the_service_build_names_real_binaries_and_enables_no_feature() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(&render().expect("render")).expect("valid YAML");
    let build = workflow["jobs"]["services"]["steps"]
        .as_sequence()
        .expect("steps")
        .iter()
        .find(|step| step["id"] == "build")
        .expect("build step")["run"]
        .as_str()
        .expect("build script");

    assert!(build.starts_with("cargo build --release --locked "));
    assert!(!build.contains("feature"), "{build}");

    let output = Command::new("cargo")
        .args([
            "metadata",
            "--no-deps",
            "--format-version",
            "1",
            "--offline",
        ])
        .current_dir(xtask_paths::repo_root())
        .output()
        .expect("cargo metadata");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("cargo metadata is JSON");
    let packages = metadata["packages"].as_array().expect("packages");

    for (package, binaries) in SERVICE_BINARIES {
        let targets = packages
            .iter()
            .find(|candidate| candidate["name"] == package)
            .unwrap_or_else(|| panic!("the workspace has no package {package}"))["targets"]
            .as_array()
            .expect("targets");
        assert!(build.contains(&format!(" -p {package} ")), "{build}");

        for binary in binaries {
            let is_binary = targets.iter().any(|target| {
                target["name"] == *binary
                    && target["kind"]
                        .as_array()
                        .is_some_and(|kinds| kinds.iter().any(|kind| kind == "bin"))
            });
            assert!(is_binary, "{package} has no binary {binary}");
            assert!(build.contains(&format!(" --bin {binary}")), "{build}");
        }
    }
}

#[test]
fn the_pinned_pdfium_digest_is_the_tracked_library() {
    let output = Command::new("sha256sum")
        .arg(
            xtask_paths::repo_root()
                .join("services/search_processing_service/pdfium-lib/linux/libpdfium.so"),
        )
        .output()
        .expect("sha256sum");
    assert!(output.status.success());
    let digest = String::from_utf8(output.stdout).expect("digest text");
    assert_eq!(digest.split_whitespace().next(), Some(PDFIUM_SHA256));
}

/// A pull request's jobs hold no registry permission and nothing in them
/// logs in, pushes or attests. Everything that does is in a job that a pull
/// request never starts.
#[test]
fn a_pull_request_holds_no_registry_permission_and_pushes_nothing() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(&render().expect("render")).expect("valid YAML");
    let publish_permissions: serde_yaml::Value =
        serde_yaml::from_str(PUBLISH_PERMISSIONS).expect("permissions");

    let mut built_on_pull_requests = BTreeSet::new();
    let mut published = BTreeSet::new();
    for (id, job) in workflow["jobs"].as_mapping().expect("jobs") {
        let id = id.as_str().expect("job id");
        let steps = job["steps"].as_sequence().expect("steps");
        let reaches_the_registry = steps.iter().any(|step| {
            let action = step["uses"].as_str().unwrap_or_default();
            step["with"]["push"] == "true"
                || action.starts_with("docker/login-action@")
                || action.starts_with("actions/attest-build-provenance@")
        });
        let dockerfiles = steps
            .iter()
            .filter_map(|step| step["with"]["file"].as_str().map(str::to_owned));

        if PUBLISHING_JOBS.contains(&id) {
            assert!(reaches_the_registry, "{id} publishes nothing");
            assert_eq!(job["if"], NOT_ON_PULL_REQUEST, "{id}");
            assert_eq!(job["permissions"], publish_permissions, "{id}");
            published.extend(dockerfiles);
        } else {
            assert!(!reaches_the_registry, "{id} reaches the registry");
            assert!(job.get("permissions").is_none(), "{id} asks for a token");
            // The services job runs on every event; the others only on a
            // pull request.
            if id != "services" {
                assert_eq!(job["if"], ON_PULL_REQUEST, "{id}");
            }
            built_on_pull_requests.extend(dockerfiles);
        }
    }

    // A pull request proves every image `main` would publish.
    assert_eq!(built_on_pull_requests, published);
    assert_eq!(published.len(), 6);
}

/// What a deployment relies on for each pushed image: its name, the commit
/// tag, `latest` on `main` alone, the source labels, provenance and an SBOM,
/// a signed attestation of the pushed digest, and that digest in the summary.
#[test]
fn every_pushed_image_is_tagged_labelled_attested_and_reported() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(&render().expect("render")).expect("valid YAML");

    let mut names = Vec::new();
    for id in PUBLISHING_JOBS {
        let steps = workflow["jobs"][id]["steps"].as_sequence().expect("steps");
        for (index, step) in steps.iter().enumerate() {
            if step["with"]["push"] != "true" {
                continue;
            }
            let build = step["id"].as_str().expect("a pushing step has an id");
            let name = build.strip_prefix("build-").expect("build step id");
            names.push(name);

            let image = format!("${{{{ env.IMAGE_NAMESPACE }}}}/{name}");
            let digest = format!("${{{{ steps.{build}.outputs.digest }}}}");
            assert_eq!(
                step["with"]["tags"].as_str().expect("tags"),
                format!(
                    "{image}:${{{{ github.sha }}}}\n${{{{ github.ref == 'refs/heads/main' && format('{{0}}/{name}:latest', env.IMAGE_NAMESPACE) || '' }}}}\n"
                )
            );
            let labels = step["with"]["labels"].as_str().expect("labels");
            // The search image holds OpenSearch, not this repository's code.
            let licence = if name == "supamac-search" {
                "org.opencontainers.image.licenses=Apache-2.0"
            } else {
                "org.opencontainers.image.licenses=AGPL-3.0-only"
            };
            for label in [
                "org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}",
                "org.opencontainers.image.revision=${{ github.sha }}",
                licence,
            ] {
                assert!(labels.lines().any(|line| line == label), "{name}: {label}");
            }
            assert_eq!(step["with"]["provenance"], "mode=max");
            assert_eq!(step["with"]["sbom"], "true");

            let attest = &steps[index + 1];
            assert!(
                attest["uses"]
                    .as_str()
                    .is_some_and(|action| action.starts_with("actions/attest-build-provenance@"))
            );
            assert_eq!(attest["with"]["subject-name"], image.as_str());
            assert_eq!(attest["with"]["subject-digest"], digest.as_str());
            assert_eq!(attest["with"]["push-to-registry"], "true");

            let report = &steps[index + 2];
            assert_eq!(report["env"]["IMAGE"], image.as_str());
            assert_eq!(report["env"]["DIGEST"], digest.as_str());
            assert!(
                report["run"]
                    .as_str()
                    .is_some_and(|script| script.contains("\"$IMAGE@$DIGEST\"")
                        && script.contains(">> \"$GITHUB_STEP_SUMMARY\""))
            );
        }
    }

    assert_eq!(
        names,
        [
            "supamac-services",
            "supamac-sync",
            "supamac-lexical",
            "supamac-ai-editing",
            "supamac-ops",
            "supamac-search",
        ]
    );
}

/// The compose stack starts a service as `/app/bin/<binary>`. The image holds
/// exactly those binaries: one that is missing fails at deployment, and one
/// that nothing starts is compiled and shipped for nothing.
#[test]
fn the_services_image_holds_exactly_the_binaries_the_compose_stack_runs() {
    const COMMAND: &str = "\"/app/bin/";
    let compose =
        std::fs::read_to_string(xtask_paths::repo_root().join("infra/self-hosted/compose.yaml"))
            .expect("compose.yaml");
    let started: BTreeSet<&str> = compose
        .match_indices(COMMAND)
        .map(|(start, _)| {
            let binary = &compose[start + COMMAND.len()..];
            &binary[..binary.find('"').expect("the command's closing quote")]
        })
        .collect();
    let built: BTreeSet<&str> = SERVICE_BINARIES
        .iter()
        .flat_map(|(_, binaries)| binaries.iter().copied())
        .collect();

    assert_eq!(built, started);
}

/// A Dockerfile or context that moved must fail here, not in a run.
#[test]
fn every_image_is_built_from_a_file_in_the_repository() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(&render().expect("render")).expect("valid YAML");
    let root = xtask_paths::repo_root();

    let mut dockerfiles = BTreeSet::new();
    for (_, job) in workflow["jobs"].as_mapping().expect("jobs") {
        for step in job["steps"].as_sequence().expect("steps") {
            let Some(dockerfile) = step["with"]["file"].as_str() else {
                continue;
            };
            xtask_paths::RepoFile::try_new(dockerfile)
                .and_then(|file| file.validate_at(&root))
                .unwrap_or_else(|error| panic!("{dockerfile}: {error}"));
            dockerfiles.insert(dockerfile);

            // A context is the checkout, a directory in it, or one a job made.
            let context = step["with"]["context"].as_str().expect("context");
            if context != "." && !context.starts_with("${{ runner.temp }}/") {
                xtask_paths::RepoDir::try_new(context)
                    .and_then(|directory| directory.validate_at(&root))
                    .unwrap_or_else(|error| panic!("{context}: {error}"));
            }
        }
    }
    assert_eq!(dockerfiles.len(), 6);
}
