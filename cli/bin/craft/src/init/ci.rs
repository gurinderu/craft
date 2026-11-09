//! The CI map in `craft init` (realm @nick/craft, nodes #482 and #483): `--propose` prints the
//! candidates the repository's workflows hold — resolved ones with the `--ci` that writes each,
//! unresolved ones with the run lines whose recipe the session reads — and `--write` records the
//! entries the reviewer confirmed, each with its workflow's hash read now.

use std::path::Path;

use anyhow::{Context, Result};
use craft_review::git;
use craft_review::project::CiEntry;
use craft_review::project::candidates::{Candidate, candidates};
use serde_json::{Value, json};

/// The confirmed entries `--ci` names, each read against the repository at `cwd`.
pub fn confirmed(given: &[String], cwd: &Path) -> Result<Vec<CiEntry>> {
    if given.is_empty() {
        return Ok(Vec::new());
    }
    let top = git::toplevel(cwd).context("reading the repository's top level")?;
    given
        .iter()
        .map(|c| CiEntry::confirmed(c, &top).map_err(anyhow::Error::msg))
        .collect()
}

/// The `--ci` that writes an entry: its JSON, as one shell argument's text.
fn ci_arg(check: &str, signal: &str, command: &str, workflow: &str) -> String {
    json!({"check": check, "signal": signal, "command": command, "workflow": workflow}).to_string()
}

/// The CI map's candidates in the repository at `cwd`, or `{"ran": false, "why"}`.
pub fn proposed(cwd: &Path) -> Value {
    let found = git::toplevel(cwd)
        .map_err(|e| e.to_string())
        .and_then(|top| candidates(&top).map_err(|e| format!("reading the workflows: {e}")));
    let found = match found {
        Ok(f) => f,
        Err(why) => return json!({"ran": false, "why": why}),
    };
    let (mut resolved, mut unresolved) = (Vec::new(), Vec::new());
    for c in found {
        match c {
            Candidate::Resolved(r) => {
                let ci = ci_arg(&r.check, r.signal.as_str(), &r.command, &r.workflow);
                let mut v = json!(r);
                if let Some(o) = v.as_object_mut() {
                    o.insert("ci".into(), Value::String(ci));
                }
                resolved.push(v);
            }
            Candidate::Unresolved(u) => unresolved.push(json!(u)),
        }
    }
    json!({"ran": true, "resolved": resolved, "unresolved": unresolved})
}
