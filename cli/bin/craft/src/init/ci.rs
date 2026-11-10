//! The CI map in `craft init` (realm @nick/craft, nodes #482 and #483): `--propose` prints the
//! candidates the repository's workflows hold — resolved ones with the `--ci` that writes each,
//! unresolved ones with the run lines whose recipe the session reads — and `--write` records the
//! entries the reviewer confirmed: a fresh one with its files' hashes read now, a held one (as
//! `ci` prints it) with the hashes it carries; `ci` gives a held one it would refuse the refusal.

use std::path::Path;

use anyhow::{Context, Result};
use craft_review::git;
use craft_review::project::CiEntry;
use craft_review::project::candidates::{Candidate, Resolved, candidates};
use craft_review::project::ci::local_file;
use serde_json::{Value, json};

/// The confirmed entries `--ci` names, each read against the repository at `cwd`.
pub fn confirmed(given: &[String], cwd: &Path) -> Result<Vec<CiEntry>> {
    if given.is_empty() {
        return Ok(Vec::new());
    }
    let top = git::toplevel(cwd).context("reading the repository's top level")?;
    given
        .iter()
        .map(|c| CiEntry::confirmed(c, &top).map_err(anyhow::Error::from))
        .collect()
}

/// The profile's `entries` as `ci` prints them, each one `--write` would refuse passed back with
/// the refusal it gives as `refused`; as they are when the repository's top cannot be read.
pub fn held(entries: &[CiEntry], cwd: &Path) -> Vec<Value> {
    let top = git::toplevel(cwd).ok();
    let one = |e: &CiEntry| {
        let mut v = json!(e);
        let why = top.as_deref().and_then(|t| e.refusal(t));
        if let (Some(o), Some(why)) = (v.as_object_mut(), why) {
            o.insert("refused".into(), Value::String(why.to_string()));
        }
        v
    };
    entries.iter().map(one).collect()
}

/// The `--ci` that writes a resolved candidate: its JSON, as one shell argument's text, each local
/// action its job runs among the sources.
fn ci_arg(top: &Path, r: &Resolved) -> String {
    let sources: Vec<String> = r.uses.iter().map(|u| local_file(top, u)).collect();
    let (check, signal) = (&r.check, r.signal.as_str());
    json!({"check": check, "signal": signal, "command": r.command, "workflow": r.workflow, "sources": sources}).to_string()
}

/// The CI map's candidates in the repository at `cwd`, or `{"ran": false, "why"}`.
pub fn proposed(cwd: &Path) -> Value {
    let found = git::toplevel(cwd)
        .map_err(|e| e.to_string())
        .and_then(|top| {
            let c = candidates(&top).map_err(|e| format!("reading the workflows: {e}"))?;
            Ok((top, c))
        });
    let (top, found) = match found {
        Ok(f) => f,
        Err(why) => return json!({"ran": false, "why": why}),
    };
    let (mut resolved, mut unresolved) = (Vec::new(), Vec::new());
    for c in found {
        match c {
            Candidate::Resolved(r) => {
                let ci = ci_arg(&top, &r);
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
