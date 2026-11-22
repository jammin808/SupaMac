//! Keep upstream deployment, release and notification jobs out of this fork,
//! and keep the workflows this fork owns off upstream's infrastructure.

use anyhow::{Context, Result, bail};
use serde_yaml::Value;

#[cfg(test)]
mod test;

const UPSTREAM_ONLY: &str = "github.repository == 'macro-inc/macro'";

/// A workflow this fork owns is generated from a module with this prefix
/// (`supamac_ci`). Every other workflow is upstream's.
pub(super) const FORK_SLUG_PREFIX: &str = "supamac_";

/// The file a fork-owned workflow is written to starts with this
/// (`supamac-ci.yml`), which is how a checked-in workflow is told apart.
pub(super) const FORK_FILE_PREFIX: &str = "supamac-";

/// GitHub-hosted runner labels. A fork-owned job runs on nothing else: the
/// labels in `runners` are machines only upstream has.
const HOSTED_RUNNERS: [&str; 2] = ["ubuntu-24.04", "macos-15"];

/// A job whose runner comes from its matrix names it this way.
const MATRIX_RUNNER: &str = "${{ matrix.runner }}";

/// The one secret that exists here: the token GitHub issues to each run.
const RUN_TOKEN: &str = "GITHUB_TOKEN";

/// Names that resolve only inside upstream: its organisation (actions, its
/// container registry, the repository boundary itself) and its AWS registry.
const UPSTREAM_REFERENCES: [&str; 2] = ["macro-inc/", ".dkr.ecr."];

/// Triggers that run with a privileged token on code the fork did not merge.
const PRIVILEGED_TRIGGERS: [&str; 2] = ["pull_request_target", "workflow_run"];

/// Add a repository boundary without weakening a job's existing condition.
pub(super) fn restrict_to_upstream(yaml: &str) -> Result<String> {
    let mut workflow: Value = serde_yaml::from_str(yaml).context("parse upstream workflow")?;
    let jobs = workflow
        .get_mut("jobs")
        .and_then(Value::as_mapping_mut)
        .context("upstream workflow has no jobs")?;

    for (_, job) in jobs {
        let mapping = job
            .as_mapping_mut()
            .context("workflow job is not a mapping")?;
        let condition = match mapping.get("if") {
            None => UPSTREAM_ONLY.to_owned(),
            Some(Value::Bool(value)) => format!("({UPSTREAM_ONLY}) && {value}"),
            Some(Value::String(value)) => {
                let value = value.trim();
                let expression = value
                    .strip_prefix("${{")
                    .and_then(|value| value.strip_suffix("}}"))
                    .unwrap_or(value)
                    .trim();
                format!("({UPSTREAM_ONLY}) && ({expression})")
            }
            Some(_) => bail!("unsupported workflow job condition"),
        };
        mapping.insert(Value::String("if".into()), Value::String(condition));
    }

    serde_yaml::to_string(&workflow).context("serialize guarded workflow")
}

/// Refuse a fork-owned workflow that could not run in this repository or that
/// drops one of the fork's workflow rules. See [`fork_owned_problems`].
pub(super) fn check_fork_owned(file_name: &str, yaml: &str) -> Result<()> {
    let problems = fork_owned_problems(file_name, yaml)?;
    if !problems.is_empty() {
        bail!(
            "fork-owned workflow `{file_name}` breaks the fork's workflow rules:\n- {}",
            problems.join("\n- ")
        );
    }
    Ok(())
}

/// What stops a fork-owned workflow from running here, or from running safely:
///
/// - a runner, secret, registry or action that only upstream has;
/// - a token wider than `contents: read` for the whole workflow, where each
///   job should ask for what it needs;
/// - a trigger that runs unmerged code with a privileged token;
/// - an action that is not pinned to a commit;
/// - runs that can overlap, or a job with no time limit.
fn fork_owned_problems(file_name: &str, yaml: &str) -> Result<Vec<String>> {
    let workflow: Value = serde_yaml::from_str(yaml).context("parse fork-owned workflow")?;
    let mut problems = Vec::new();

    if !file_name.starts_with(FORK_FILE_PREFIX) {
        problems.push(format!(
            "its file name does not start with `{FORK_FILE_PREFIX}`"
        ));
    }

    for reference in UPSTREAM_REFERENCES {
        if yaml.contains(reference) {
            problems.push(format!(
                "it names `{reference}`, which exists only upstream"
            ));
        }
    }

    for read in secret_reads(yaml) {
        match read {
            SecretRead::Named(secret) if secret.eq_ignore_ascii_case(RUN_TOKEN) => {}
            SecretRead::Named(secret) => problems.push(format!(
                "it reads the secret `{secret}`; only `{RUN_TOKEN}` exists here"
            )),
            SecretRead::Unnamed => problems.push(format!(
                "it reads the `secrets` context other than as `secrets.{RUN_TOKEN}`"
            )),
        }
    }

    for trigger in PRIVILEGED_TRIGGERS {
        if workflow["on"].get(trigger).is_some() {
            problems.push(format!("it runs on `{trigger}`"));
        }
    }

    let read_only: Value = serde_yaml::from_str("contents: read").context("parse permissions")?;
    if workflow["permissions"] != read_only {
        problems.push("its workflow permissions are not exactly `contents: read`".to_owned());
    }

    if workflow.get("concurrency").is_none() {
        problems.push("it has no concurrency group".to_owned());
    }

    let jobs = workflow["jobs"]
        .as_mapping()
        .context("fork-owned workflow has no jobs")?;
    for (id, job) in jobs {
        let id = id.as_str().context("job id is not a string")?;

        if !runs_on_hosted_runner(job) {
            problems.push(format!("job `{id}` does not run on a GitHub-hosted runner"));
        }
        if job.get("timeout-minutes").is_none() {
            problems.push(format!("job `{id}` has no timeout"));
        }
        if job.get("secrets").is_some() {
            problems.push(format!("job `{id}` passes secrets to another workflow"));
        }

        for step in job["steps"].as_sequence().into_iter().flatten() {
            let Some(action) = step["uses"].as_str() else {
                continue;
            };
            if !pinned_to_commit(action) {
                problems.push(format!(
                    "job `{id}` uses `{action}`, which is not pinned to a commit"
                ));
            }
        }
    }

    Ok(problems)
}

/// How a workflow reads the `secrets` context.
#[derive(Debug, PartialEq, Eq)]
enum SecretRead<'a> {
    /// `secrets.<NAME>`.
    Named(&'a str),
    /// An index (`secrets['NAME']`) or the whole context (`toJSON(secrets)`)
    /// inside an expression, either of which can reach any secret.
    Unnamed,
}

/// Every read of the `secrets` context in the workflow text, in order of
/// appearance. The context is matched in any letter case, as the expression
/// language reads it. `secrets` as a property of another context
/// (`needs.secrets.result`) or in prose is not a read.
fn secret_reads(yaml: &str) -> Vec<SecretRead<'_>> {
    const CONTEXT: &str = "secrets";
    const EXPRESSION_OPEN: &str = "${{";
    const EXPRESSION_CLOSE: &str = "}}";
    let is_name_character =
        |character: char| character.is_ascii_alphanumeric() || character == '_' || character == '-';

    // Lowering ASCII keeps every byte offset, so matches index into `yaml`.
    yaml.to_ascii_lowercase()
        .match_indices(CONTEXT)
        .filter_map(|(start, _)| {
            let before = &yaml[..start];
            if before.ends_with(|character| is_name_character(character) || character == '.') {
                return None;
            }

            let after = &yaml[start + CONTEXT.len()..];
            if let Some(name) = after.strip_prefix('.') {
                let end = name
                    .find(|character| !is_name_character(character))
                    .unwrap_or(name.len());
                return Some(SecretRead::Named(&name[..end]));
            }

            let in_expression = before.rfind(EXPRESSION_OPEN) > before.rfind(EXPRESSION_CLOSE);
            let after = after.trim_start_matches(' ');
            let ends_the_operand =
                after.starts_with(['[', ')', ',']) || after.starts_with(EXPRESSION_CLOSE);
            (in_expression && ends_the_operand).then_some(SecretRead::Unnamed)
        })
        .collect()
}

/// Whether the job's runner, or every runner of its matrix, is GitHub-hosted.
fn runs_on_hosted_runner(job: &Value) -> bool {
    let Some(label) = job["runs-on"].as_str() else {
        return false;
    };
    if label != MATRIX_RUNNER {
        return HOSTED_RUNNERS.contains(&label);
    }

    let Some(legs) = job["strategy"]["matrix"]["include"].as_sequence() else {
        return false;
    };
    !legs.is_empty()
        && legs.iter().all(|leg| {
            leg["runner"]
                .as_str()
                .is_some_and(|runner| HOSTED_RUNNERS.contains(&runner))
        })
}

/// Whether a step's `uses` names a full commit SHA, which a tag or a branch
/// can never be moved onto.
fn pinned_to_commit(action: &str) -> bool {
    action.rsplit_once('@').is_some_and(|(_, reference)| {
        reference.len() == 40
            && reference
                .chars()
                .all(|character| matches!(character, '0'..='9' | 'a'..='f'))
    })
}
