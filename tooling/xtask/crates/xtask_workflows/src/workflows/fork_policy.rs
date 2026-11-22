//! Keep upstream deployment, release and notification jobs out of this fork,
//! and keep the workflows this fork owns off upstream's infrastructure.
//!
//! [`apply`] is the one place the generator calls: it holds a fork-owned
//! workflow to the fork's rules and gives every job of any other workflow the
//! repository boundary.

use anyhow::{Context, Result, anyhow, bail};
use gh_workflow::expr::typed::{Str, github, matrix};
use gh_workflow::expr::{self, Ast, Op, TemplatePart};
use serde_yaml::Value;

use crate::workflows::WorkflowFile;

#[cfg(test)]
mod test;

/// The repository upstream's workflows belong to. Their jobs run nowhere else.
const UPSTREAM_REPOSITORY: &str = "macro-inc/macro";

/// A workflow this fork owns is generated from a module with this prefix
/// (`supamac_ci`). Every other workflow is upstream's.
const FORK_SLUG_PREFIX: &str = "supamac_";

/// The file a fork-owned workflow is written to starts with this
/// (`supamac-ci.yml`), which is how a checked-in workflow is told apart.
const FORK_FILE_PREFIX: &str = "supamac-";

/// GitHub-hosted runner labels. A fork-owned job runs on nothing else: the
/// labels in `runners` are machines only upstream has.
const HOSTED_RUNNERS: [&str; 2] = ["ubuntu-24.04", "macos-15"];

/// The matrix key a job names its runner by when the runner varies by leg.
const MATRIX_RUNNER_KEY: &str = "runner";

/// The one secret that exists here: the token GitHub issues to each run.
const RUN_TOKEN: &str = "GITHUB_TOKEN";

/// Names that resolve only inside upstream: its organisation (actions, its
/// container registry, the repository boundary itself) and its AWS registry.
const UPSTREAM_REFERENCES: [&str; 2] = ["macro-inc/", ".dkr.ecr."];

/// Triggers that run with a privileged token on code the fork did not merge.
const PRIVILEGED_TRIGGERS: [&str; 2] = ["pull_request_target", "workflow_run"];

/// The key a job's condition is written under.
const CONDITION_KEY: &str = "if";

/// How far the emitter indents a job's id and a job's own keys.
const JOB_INDENT: usize = 2;
const JOB_KEY_INDENT: usize = 4;

/// Whether this fork owns the workflow instead of importing it from upstream.
/// Its module carries the fork's prefix (`supamac_ci`) and so does its file
/// (`supamac-ci.yml`). A fork-owned workflow runs in this repository; every
/// job of any other workflow is restricted to the upstream repository.
pub(super) fn is_fork_owned(workflow: &WorkflowFile) -> bool {
    workflow.slug.starts_with(FORK_SLUG_PREFIX)
}

/// Put a rendered workflow on its side of the repository boundary: a
/// fork-owned one is refused unless it keeps the fork's rules
/// ([`check_fork_owned`]), and any other one comes back with each job
/// restricted to the upstream repository ([`restrict_to_upstream`]).
pub(super) fn apply(workflow: &WorkflowFile, yaml: String) -> Result<String> {
    if is_fork_owned(workflow) {
        check_fork_owned(workflow.file_name, &yaml)?;
        Ok(yaml)
    } else {
        restrict_to_upstream(&yaml)
            .with_context(|| format!("restricting {} to upstream", workflow.file_name))
    }
}

/// Add the repository boundary to every job without weakening the job's own
/// condition. Only the lines that hold a job's condition change: every other
/// line, comments included, stays as upstream's emitter wrote it, so a
/// workflow here differs from upstream's by its conditions alone. The result
/// is read back and compared with the input, so a layout this does not
/// understand is an error and never a wrong workflow.
pub(super) fn restrict_to_upstream(yaml: &str) -> Result<String> {
    let workflow: Value = serde_yaml::from_str(yaml).context("parse upstream workflow")?;
    let jobs = workflow
        .get("jobs")
        .and_then(Value::as_mapping)
        .context("upstream workflow has no jobs")?;

    let mut conditions = Vec::with_capacity(jobs.len());
    for (id, job) in jobs {
        let id = id.as_str().context("job id is not a string")?;
        if !job.is_mapping() {
            bail!("workflow job `{id}` is not a mapping");
        }
        let condition = upstream_only(job.get(CONDITION_KEY))
            .with_context(|| format!("the condition of job `{id}`"))?;
        conditions.push(JobCondition {
            id,
            condition,
            replaces: job.get(CONDITION_KEY).is_some(),
        });
    }

    let guarded = write_conditions(yaml, &conditions)?;
    verify_only_conditions_changed(&workflow, &guarded, &conditions)?;
    Ok(guarded)
}

/// The condition one job is given.
struct JobCondition<'a> {
    id: &'a str,
    condition: String,
    /// Whether the job already has a condition, whose line this one takes.
    replaces: bool,
}

/// Where [`write_conditions`] is in the workflow text.
enum Section {
    BeforeJobs,
    Jobs,
    AfterJobs,
}

/// Rewrite the text of a workflow as the emitter lays it out: job ids two
/// spaces in under a top-level `jobs:`, each job's keys four spaces in, a
/// condition on one line. A job with a condition keeps it in place; one
/// without gets it as its first key.
fn write_conditions(yaml: &str, conditions: &[JobCondition<'_>]) -> Result<String> {
    let mut guarded = String::with_capacity(yaml.len() + conditions.len() * 80);
    let mut remaining = conditions.iter();
    let mut section = Section::BeforeJobs;
    // The job being read, until its own condition line has been replaced.
    let mut awaiting: Option<&JobCondition<'_>> = None;
    // Set by a replaced condition: the next line must not continue it.
    let mut after_condition = false;

    for line in yaml.split_inclusive('\n') {
        let text = line.trim_end_matches('\n');
        let indent = text.len() - text.trim_start_matches(' ').len();

        match section {
            Section::BeforeJobs => {
                if text == "jobs:" {
                    section = Section::Jobs;
                }
                guarded.push_str(line);
                continue;
            }
            Section::AfterJobs => {
                guarded.push_str(line);
                continue;
            }
            Section::Jobs => {}
        }

        // A blank line belongs to a block scalar.
        if text.trim().is_empty() {
            guarded.push_str(line);
            continue;
        }
        if after_condition && indent > JOB_KEY_INDENT {
            bail!("a job condition spans more than one line");
        }
        after_condition = false;

        if indent == 0 {
            section = Section::AfterJobs;
            guarded.push_str(line);
        } else if indent == JOB_INDENT {
            if let Some(job) = awaiting {
                bail!("job `{}` has no line for its condition", job.id);
            }
            let job = remaining
                .next()
                .with_context(|| format!("`{text}` is not a job of the workflow"))?;
            if text != format!("{:JOB_INDENT$}{}:", "", job.id) {
                bail!("expected job `{}` at `{text}`", job.id);
            }
            guarded.push_str(line);
            if job.replaces {
                awaiting = Some(job);
            } else {
                guarded.push_str(&condition_line(&job.condition));
            }
        } else if indent == JOB_KEY_INDENT && is_condition_line(text) {
            let job = awaiting
                .take()
                .with_context(|| format!("unexpected condition at `{text}`"))?;
            guarded.push_str(&condition_line(&job.condition));
            after_condition = true;
        } else {
            guarded.push_str(line);
        }
    }

    if let Some(job) = awaiting {
        bail!("job `{}` has no line for its condition", job.id);
    }
    if let Some(job) = remaining.next() {
        bail!("job `{}` is not in the workflow text", job.id);
    }
    Ok(guarded)
}

/// Whether a job-level line is the job's `if:` entry.
fn is_condition_line(text: &str) -> bool {
    text.trim_start()
        .strip_prefix(CONDITION_KEY)
        .is_some_and(|rest| rest.starts_with(':'))
}

/// A job's `if:` line. The condition is written plain where YAML reads it
/// back unchanged and in single quotes otherwise, as the emitter does.
fn condition_line(condition: &str) -> String {
    let plain = !condition.contains(": ") && !condition.contains(" #") && !condition.ends_with(':');
    let scalar = if plain {
        condition.to_owned()
    } else {
        format!("'{}'", condition.replace('\'', "''"))
    };
    format!("{:JOB_KEY_INDENT$}{CONDITION_KEY}: {scalar}\n", "")
}

/// Read `guarded` back and refuse it unless it is `original` with exactly the
/// wanted condition on each job and nothing else added, dropped or changed.
fn verify_only_conditions_changed(
    original: &Value,
    guarded: &str,
    conditions: &[JobCondition<'_>],
) -> Result<()> {
    let reread: Value = serde_yaml::from_str(guarded).context("parse guarded workflow")?;
    let (Some(before), Some(after)) = (original.as_mapping(), reread.as_mapping()) else {
        bail!("a workflow is not a mapping");
    };
    if before.len() != after.len() {
        bail!("the guarded workflow has other top-level keys");
    }

    for (key, value) in before {
        let guarded_value = after.get(key).context("a top-level key was dropped")?;
        if key.as_str() != Some("jobs") {
            if guarded_value != value {
                bail!("`{key:?}` changed outside the jobs");
            }
            continue;
        }

        let (Some(jobs), Some(guarded_jobs)) = (value.as_mapping(), guarded_value.as_mapping())
        else {
            bail!("the jobs are not a mapping");
        };
        if jobs.len() != guarded_jobs.len() || jobs.len() != conditions.len() {
            bail!("the guarded workflow has other jobs");
        }
        for (wanted, (id, job)) in conditions.iter().zip(jobs) {
            let guarded_job = guarded_jobs
                .get(id)
                .and_then(Value::as_mapping)
                .with_context(|| format!("job `{}` was dropped", wanted.id))?;
            let job = job.as_mapping().context("a job is not a mapping")?;

            if guarded_job.get(CONDITION_KEY).and_then(Value::as_str)
                != Some(wanted.condition.as_str())
            {
                bail!("job `{}` did not get its condition", wanted.id);
            }
            let kept = job
                .iter()
                .filter(|(key, _)| key.as_str() != Some(CONDITION_KEY))
                .all(|(key, value)| guarded_job.get(key) == Some(value));
            let added = usize::from(!wanted.replaces);
            if !kept || guarded_job.len() != job.len() + added {
                bail!("job `{}` changed beyond its condition", wanted.id);
            }
        }
    }
    Ok(())
}

/// The condition of an upstream job: the repository boundary, and after it
/// whatever condition the job already had, in parentheses unless it is a
/// literal. A status function in it (`always()`, `failure()`) stays in the
/// expression, so GitHub still adds no implicit `success()`.
fn upstream_only(existing: Option<&Value>) -> Result<String> {
    let boundary = github().repository().eq(UPSTREAM_REPOSITORY).into_ast();
    let existing = match existing {
        None => return Ok(boundary.to_string()),
        Some(Value::Bool(value)) => Ast::Bool(*value),
        Some(Value::String(text)) => condition_ast(text)?,
        Some(_) => bail!("unsupported workflow job condition"),
    };
    let existing = match existing {
        literal @ (Ast::Bool(_) | Ast::Group(_)) => literal,
        expression => Ast::Group(Box::new(expression)),
    };

    let condition = Ast::Binary(
        Op::And,
        Box::new(Ast::Group(Box::new(boundary))),
        Box::new(existing),
    )
    .to_string();
    // The whole condition must read only what a job's `if:` offers. Which job
    // makes no difference to that.
    let scope = expr::scope::at(&["jobs", "job", CONDITION_KEY])
        .context("a job condition takes no expression")?;
    expr::canonicalize(&condition, scope.contexts, scope.whole_expression)
        .map_err(|error| anyhow!(error))
}

/// A job condition as an expression, written bare or as one `${{ }}`.
fn condition_ast(text: &str) -> Result<Ast> {
    if !text.contains("${{") {
        return expr::parse(text).map_err(|error| anyhow!(error));
    }

    let mut parts = expr::parse_template(text)
        .map_err(|error| anyhow!(error))?
        .into_iter()
        .filter(|part| !matches!(part, TemplatePart::Text(text) if text.trim().is_empty()));
    match (parts.next(), parts.next()) {
        (Some(TemplatePart::Expression(ast)), None) => Ok(ast),
        _ => bail!("`{text}` is not one expression"),
    }
}

/// Refuse a fork-owned workflow that could not run in this repository or that
/// drops one of the fork's workflow rules. See [`fork_owned_problems`].
fn check_fork_owned(file_name: &str, yaml: &str) -> Result<()> {
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

    for secret in secret_names(yaml) {
        if secret != RUN_TOKEN {
            problems.push(format!(
                "it reads the secret `{secret}`; only `{RUN_TOKEN}` exists here"
            ));
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

/// Every `secrets.<NAME>` the workflow text reads, in order of appearance.
fn secret_names(yaml: &str) -> Vec<&str> {
    const CONTEXT: &str = "secrets.";
    let is_name_character = |character: char| character.is_ascii_alphanumeric() || character == '_';

    yaml.match_indices(CONTEXT)
        .filter(|(start, _)| {
            // `secrets.` at the end of a longer identifier is not the context.
            !yaml[..*start].ends_with(is_name_character)
        })
        .map(|(start, _)| {
            let name = &yaml[start + CONTEXT.len()..];
            let end = name
                .find(|character| !is_name_character(character))
                .unwrap_or(name.len());
            &name[..end]
        })
        .collect()
}

/// Whether the job's runner, or every runner of its matrix, is GitHub-hosted.
fn runs_on_hosted_runner(job: &Value) -> bool {
    let Some(label) = job["runs-on"].as_str() else {
        return false;
    };
    if label != matrix::<Str>(MATRIX_RUNNER_KEY).to_string() {
        return HOSTED_RUNNERS.contains(&label);
    }

    let Some(legs) = job["strategy"]["matrix"]["include"].as_sequence() else {
        return false;
    };
    !legs.is_empty()
        && legs.iter().all(|leg| {
            leg[MATRIX_RUNNER_KEY]
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
