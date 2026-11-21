//! Keep upstream deployment, release and notification jobs out of this fork.

use anyhow::{Context, Result, bail};
use serde_yaml::Value;

#[cfg(test)]
mod test;

const UPSTREAM_ONLY: &str = "github.repository == 'macro-inc/macro'";

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
