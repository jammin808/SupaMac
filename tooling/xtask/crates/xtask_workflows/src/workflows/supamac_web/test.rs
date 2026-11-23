use std::path::Path;
use std::process::{Command, Output};

use super::*;

/// The rendered step `name` of `job`: the workflow as GitHub would run it.
fn step(job: &str, name: &str) -> serde_yaml::Value {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(&render().expect("render")).expect("valid YAML");
    workflow["jobs"][job]["steps"]
        .as_sequence()
        .expect("steps")
        .iter()
        .find(|step| step["name"] == name)
        .unwrap_or_else(|| panic!("{job} has no step {name}"))
        .clone()
}

fn bash(script: &str, environment: &[(&str, &str)]) -> Output {
    Command::new("bash")
        .args(["-c", script])
        .envs(environment.iter().copied())
        .output()
        .expect("run bash")
}

fn git(directory: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.invalid",
        ])
        .args(arguments)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {arguments:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("git output")
}

/// A bundle built for the placeholders must never reach the publishing job:
/// outside a pull request, unset variables stop the run before it builds.
#[test]
fn only_a_pull_request_builds_for_the_placeholders() {
    let resolve = step("build", "Resolve the folder and the backend to build for");
    assert_eq!(
        resolve["env"]["CONFIGURED_BASE_PATH"],
        "${{ vars.SUPAMAC_WEB_BASE_PATH }}"
    );
    assert_eq!(
        resolve["env"]["CONFIGURED_BACKEND_ORIGIN"],
        "${{ vars.SUPAMAC_BACKEND_ORIGIN }}"
    );
    assert_eq!(resolve["id"], "inputs");
    let script = resolve["run"].as_str().expect("script");

    let temporary = tempfile::tempdir().expect("temporary directory");
    let outputs_file = temporary.path().join("github output");
    let outputs_path = outputs_file.to_str().expect("path");

    for (event, base_path, backend_origin, written) in [
        (
            "pull_request",
            "",
            "",
            Some("base_path=/workspace\nbackend_origin=https://api.example.com\n"),
        ),
        (
            "pull_request",
            "/team/app",
            "https://backend.example.org",
            Some("base_path=/team/app\nbackend_origin=https://backend.example.org\n"),
        ),
        (
            "push",
            "/team/app",
            "https://backend.example.org:8443",
            Some("base_path=/team/app\nbackend_origin=https://backend.example.org:8443\n"),
        ),
        ("push", "", "", None),
        ("push", "/team/app", "", None),
        ("workflow_dispatch", "", "https://backend.example.org", None),
        ("push", "team/app/", "https://backend.example.org", None),
        ("push", "/team/app", "http://backend.example.org", None),
        ("push", "/team/app", "https://backend.example.org/api", None),
        (
            "pull_request",
            "/team/app",
            "https://backend.example.org/api",
            None,
        ),
        // The build refuses an origin a browser would report differently.
        ("push", "/team/app", "https://Backend.example.org", None),
        ("push", "/team/app", "https://backend.example.org:443", None),
        (
            "push",
            "/team/app\nNODE_OPTIONS=--require=/tmp/x",
            "https://backend.example.org",
            None,
        ),
    ] {
        std::fs::write(&outputs_file, "").expect("empty outputs file");
        let output = bash(
            script,
            &[
                ("GITHUB_EVENT_NAME", event),
                ("CONFIGURED_BASE_PATH", base_path),
                ("CONFIGURED_BACKEND_ORIGIN", backend_origin),
                ("GITHUB_OUTPUT", outputs_path),
            ],
        );
        let wrote = std::fs::read_to_string(&outputs_file).expect("outputs file");
        let case = format!("{event} with {base_path:?} and {backend_origin:?}");

        match written {
            Some(expected) => {
                assert!(output.status.success(), "{case}");
                assert_eq!(wrote, expected, "{case}");
            }
            None => {
                assert!(!output.status.success(), "{case}");
                assert_eq!(wrote, "", "{case}");
                assert!(
                    String::from_utf8_lossy(&output.stdout).contains("::error title="),
                    "{case}"
                );
            }
        }
    }
}

/// The unit tests cover the hosted and the local service addresses as well as
/// the self-hosted ones, and five of them fail with a backend origin in their
/// environment. So the two build inputs reach only the steps that build and
/// package the bundle, each through its own `env`, and no step writes to the
/// environment of the steps after it.
#[test]
fn only_the_build_and_the_packaging_are_given_the_build_inputs() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(&render().expect("render")).expect("valid YAML");
    let build = &workflow["jobs"]["build"];
    let inputs = ["MACRO_APP_BASE_PATH", "VITE_BACKEND_ORIGIN"];

    for name in inputs {
        assert!(workflow["env"].get(name).is_none(), "workflow sets {name}");
        assert!(build["env"].get(name).is_none(), "job sets {name}");
    }

    let mut given = Vec::new();
    for step in build["steps"].as_sequence().expect("steps") {
        let name = step["name"].as_str().expect("step name");
        assert!(
            !step["run"]
                .as_str()
                .unwrap_or_default()
                .contains("GITHUB_ENV"),
            "{name} writes to the environment of later steps"
        );
        if inputs.iter().any(|input| step["env"].get(input).is_some()) {
            assert_eq!(
                step["env"]["MACRO_APP_BASE_PATH"], "${{ steps.inputs.outputs.base_path }}",
                "{name}"
            );
            assert_eq!(
                step["env"]["VITE_BACKEND_ORIGIN"], "${{ steps.inputs.outputs.backend_origin }}",
                "{name}"
            );
            given.push(name);
        }
    }
    assert_eq!(given, ["Build the bundle", "Package the folder to publish"]);

    let tests = step("build", "Test the self-hosted build inputs");
    assert!(tests.get("env").is_none());
}

/// The publishing job holds the one token that can write to the repository.
/// Its push must replace exactly one branch with exactly one commit, the
/// packaged folder, and leave every other ref as it was.
#[test]
fn publishing_replaces_one_branch_with_one_commit_and_no_other_ref() {
    let publish = step(
        "publish",
        "Make the folder the only commit of supamac-web-dist",
    );
    assert_eq!(publish["env"]["BRANCH"], "supamac-web-dist");
    assert_eq!(
        publish["env"]["EXPECTED_BASE_PATH"],
        "${{ vars.SUPAMAC_WEB_BASE_PATH }}"
    );
    assert_eq!(
        publish["env"]["EXPECTED_BACKEND_ORIGIN"],
        "${{ vars.SUPAMAC_BACKEND_ORIGIN }}"
    );
    let script = publish["run"].as_str().expect("script");

    // A remote with `main`, a tag and an earlier publish of two commits.
    let temporary = tempfile::tempdir().expect("temporary directory");
    let remote = temporary.path().join("remote.git");
    let seed = temporary.path().join("seed");
    std::fs::create_dir_all(&remote).expect("remote directory");
    std::fs::create_dir_all(&seed).expect("seed directory");
    git(
        &remote,
        &["init", "--quiet", "--bare", "--initial-branch", "main"],
    );
    git(&seed, &["init", "--quiet", "--initial-branch", "main"]);
    std::fs::write(seed.join("README.md"), "source\n").expect("source file");
    git(&seed, &["add", "--all"]);
    git(&seed, &["commit", "--quiet", "--message", "source"]);
    git(&seed, &["tag", "v1"]);
    git(&seed, &["checkout", "--quiet", "-b", "supamac-web-dist"]);
    for earlier in ["earlier-AbCd1234.js", "earlier-EfGh5678.js"] {
        std::fs::write(seed.join(earlier), "earlier\n").expect("earlier file");
        git(&seed, &["add", "--all"]);
        git(&seed, &["commit", "--quiet", "--message", earlier]);
    }
    let remote_path = remote.to_str().expect("path");
    git(
        &seed,
        &[
            "push",
            "--quiet",
            remote_path,
            "main",
            "v1",
            "supamac-web-dist",
        ],
    );
    let main_before = git(&remote, &["rev-parse", "refs/heads/main"]);
    let tag_before = git(&remote, &["rev-parse", "refs/tags/v1"]);
    let published_before = git(&remote, &["rev-parse", "refs/heads/supamac-web-dist"]);

    // The packaged folder and its manifest, as the build job's artifact holds them.
    let site = temporary.path().join("published/supamac-web");
    std::fs::create_dir_all(site.join("assets")).expect("site");
    std::fs::write(site.join("index.html"), "<!doctype html>\n").expect("page");
    std::fs::write(site.join(".htaccess"), "RewriteEngine On\n").expect("rules");
    std::fs::write(site.join("assets/app-AbCd1234.js"), "export {};\n").expect("script");
    let manifest = temporary.path().join("published/supamac-web.publish.json");
    std::fs::write(
        &manifest,
        r#"{"basePath": "/team/app", "backendOrigin": "https://backend.example.org"}"#,
    )
    .expect("manifest");
    let summary = temporary.path().join("summary.md");

    let environment = |backend_origin: &'static str| {
        [
            ("SITE", site.to_str().expect("path").to_owned()),
            ("MANIFEST", manifest.to_str().expect("path").to_owned()),
            ("EXPECTED_BASE_PATH", "/team/app".to_owned()),
            ("EXPECTED_BACKEND_ORIGIN", backend_origin.to_owned()),
            ("REMOTE", remote_path.to_owned()),
            ("BRANCH", "supamac-web-dist".to_owned()),
            (
                "SOURCE_SHA",
                "0123456789abcdef0123456789abcdef01234567".to_owned(),
            ),
            ("GITHUB_TOKEN", "unused-by-a-local-remote".to_owned()),
            (
                "GITHUB_STEP_SUMMARY",
                summary.to_str().expect("path").to_owned(),
            ),
            ("GIT_CONFIG_GLOBAL", "/dev/null".to_owned()),
            ("GIT_CONFIG_NOSYSTEM", "1".to_owned()),
        ]
    };
    let run = |backend_origin: &'static str| {
        let environment = environment(backend_origin);
        let environment: Vec<(&str, &str)> = environment
            .iter()
            .map(|(name, value)| (*name, value.as_str()))
            .collect();
        bash(script, &environment)
    };

    // A folder packaged for another backend, or with the variable unset, is
    // not published.
    for backend_origin in ["https://other.example.org", ""] {
        let refused = run(backend_origin);
        assert!(!refused.status.success(), "{backend_origin:?}");
        assert_eq!(
            git(&remote, &["rev-parse", "refs/heads/supamac-web-dist"]),
            published_before
        );
        assert!(!site.join(".git").exists());
    }

    let published = run("https://backend.example.org");
    assert!(
        published.status.success(),
        "{}",
        String::from_utf8_lossy(&published.stderr)
    );

    assert_eq!(
        git(&remote, &["for-each-ref", "--format=%(refname)"]),
        "refs/heads/main\nrefs/heads/supamac-web-dist\nrefs/tags/v1\n"
    );
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/main"]), main_before);
    assert_eq!(git(&remote, &["rev-parse", "refs/tags/v1"]), tag_before);
    assert_eq!(
        git(
            &remote,
            &["rev-list", "--count", "refs/heads/supamac-web-dist"]
        ),
        "1\n"
    );
    assert_eq!(
        git(
            &remote,
            &[
                "ls-tree",
                "-r",
                "--name-only",
                "refs/heads/supamac-web-dist"
            ]
        ),
        ".htaccess\nassets/app-AbCd1234.js\nindex.html\n"
    );
    assert_eq!(
        git(
            &remote,
            &["log", "-1", "--format=%s", "refs/heads/supamac-web-dist"]
        ),
        "Web bundle built from 0123456789abcdef0123456789abcdef01234567\n"
    );
}

/// The job that can write to the repository runs only on `main`, never on a
/// pull request, and executes nothing but the download and the push.
#[test]
fn only_the_publishing_job_can_write_and_it_runs_no_code_of_the_build() {
    let workflow: serde_yaml::Value =
        serde_yaml::from_str(&render().expect("render")).expect("valid YAML");

    assert!(workflow["jobs"]["build"].get("permissions").is_none());

    let publish = &workflow["jobs"]["publish"];
    assert_eq!(
        publish["if"],
        "github.ref == 'refs/heads/main' && github.event_name != 'pull_request'"
    );
    assert_eq!(publish["needs"][0], "build");
    assert_eq!(
        publish["permissions"],
        serde_yaml::from_str::<serde_yaml::Value>("contents: write").expect("permissions")
    );
    let steps = publish["steps"].as_sequence().expect("steps");
    assert_eq!(steps.len(), 2);
    assert!(
        steps[0]["uses"]
            .as_str()
            .is_some_and(|action| action.starts_with("actions/download-artifact@"))
    );
    assert!(steps[1].get("uses").is_none());
}

/// Each tool is checked against its digest before it is unpacked, also when
/// the runner's temporary directory has a space in its path.
#[test]
fn downloaded_tools_are_verified_in_paths_with_spaces() {
    let install = step("build", "Install pinned WebAssembly tooling");
    let script = install["run"].as_str().expect("script");

    let temporary = tempfile::Builder::new()
        .prefix("tool paths ")
        .tempdir()
        .expect("temporary directory");
    let fixture = temporary.path().join("fixture");
    std::fs::write(&fixture, b"checksum fixture").expect("fixture");
    let digest = Command::new("sha256sum")
        .arg(&fixture)
        .output()
        .expect("sha256sum");
    let digest = String::from_utf8(digest.stdout).expect("digest text");
    let digest = digest.split_whitespace().next().expect("digest");

    let mut verified = Vec::new();
    for line in script
        .lines()
        .filter(|line| line.contains("sha256sum --check"))
    {
        let pinned = line
            .split('\'')
            .nth(1)
            .and_then(|format| format.split_whitespace().next())
            .expect("pinned digest");
        assert_eq!(pinned.len(), 64);
        let archive = line
            .split("$RUNNER_TEMP/")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("archive name");
        std::fs::copy(&fixture, temporary.path().join(archive)).expect("archive fixture");

        let runner_temp = temporary.path().to_str().expect("path");
        let matching = bash(
            &line.replace(pinned, digest),
            &[("RUNNER_TEMP", runner_temp)],
        );
        assert!(
            matching.status.success(),
            "{}",
            String::from_utf8_lossy(&matching.stderr)
        );
        // The pinned digest is not the fixture's, so the line as written fails.
        assert!(!bash(line, &[("RUNNER_TEMP", runner_temp)]).status.success());
        verified.push(archive.to_owned());
    }
    assert_eq!(
        verified,
        [
            "just.tar.gz",
            "wasm-pack.tar.gz",
            "wasm-bindgen.tar.gz",
            "binaryen.tar.gz"
        ]
    );
}

/// wasm-pack takes wasm-bindgen from the path only when it is the release
/// `Cargo.lock` names. Given any other, it downloads its own, unchecked.
#[test]
fn pinned_wasm_bindgen_is_the_locked_release() {
    let install = step("build", "Install pinned WebAssembly tooling");
    let pinned = install["run"]
        .as_str()
        .expect("script")
        .split("wasm-bindgen/releases/download/")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .expect("pinned wasm-bindgen release");

    let lockfile =
        std::fs::read_to_string(xtask_paths::repo_root().join("Cargo.lock")).expect("Cargo.lock");
    assert!(
        lockfile.contains(&format!(
            "name = \"wasm-bindgen\"\nversion = \"{pinned}\"\n"
        )),
        "Cargo.lock does not name wasm-bindgen {pinned}"
    );
}
