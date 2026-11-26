//! The finished run's record filed in the store by the binary (`start --record`; realm @nick/craft,
//! node #616): the attempt is marked before the write, so a run that finishes again sends it as a
//! retry and the store answers `already filed`; a write that did not land is one line of `lost`,
//! `<what> — <why>`, as `triage-findings.js` notes it.

use std::path::{Path, PathBuf};

use craft_review::filing::{Call, WriteError, Writer};
use craft_store::js::Js;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::TriageError;
use crate::run::Recording;
use crate::state::TriageState;

/// Where the run keeps what its filing did.
#[must_use]
pub fn filing_path(dir: &Path) -> PathBuf {
    dir.join("filing.json")
}

/// What the filing did, in the shape the review's telemetry reads it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Filed {
    /// `filed` or `failed`; `attempted` while the write has not answered.
    pub record: String,
    pub file: String,
    pub lost: Vec<String>,
}

/// Files `record` for the run in `dir` when it records; `None` when it does not.
///
/// # Errors
/// When the attempt or what it did cannot be kept beside the state.
pub(super) fn file(
    dir: &Path,
    s: &TriageState,
    record: &Js,
    w: &dyn Writer,
) -> Result<Option<Filed>, TriageError> {
    let Some(at) = &s.args.record else {
        return Ok(None);
    };
    let retry = read(dir).is_some();
    let attempted = Filed {
        record: "attempted".into(),
        ..Filed::default()
    };
    keep(dir, &attempted)?;
    let filed = match Value::try_from(record) {
        Ok(rec) => answered(send(dir, s, at, &rec, retry, w)),
        Err(e) => failed(&format!("the record holds text JSON cannot carry: {e}"), ""),
    };
    keep(dir, &filed)?;
    Ok(Some(filed))
}

/// What the run's filing did, when it filed.
#[must_use]
pub fn read(dir: &Path) -> Option<Filed> {
    let text = std::fs::read_to_string(filing_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

fn keep(dir: &Path, filed: &Filed) -> Result<(), TriageError> {
    let path = filing_path(dir);
    let text = serde_json::to_string_pretty(filed).unwrap_or_default();
    std::fs::write(&path, format!("{text}\n"))
        .map_err(|source| TriageError::Unwritable { path, source })
}

fn send(
    dir: &Path,
    s: &TriageState,
    at: &Recording,
    record: &Value,
    retry: bool,
    w: &dyn Writer,
) -> Result<Value, WriteError> {
    let request = json!({
        "repo": s.cwd.display().to_string(),
        "session": at.session,
        "record": record,
        "retry": retry,
    });
    w.write(&Call {
        run: dir,
        root: &at.root,
        command: "record",
        request: &request,
    })
}

/// The writer's `{ ok, reason, file }`, or why it gave none.
fn answered(got: Result<Value, WriteError>) -> Filed {
    let a = match got {
        Ok(a) => a,
        Err(e) => return failed(&e.to_string(), ""),
    };
    let text = |k: &str| {
        a.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let (reason, file) = (text("reason"), text("file"));
    if a.get("ok") != Some(&Value::Bool(true)) {
        let why = if reason.is_empty() {
            "the writer gave no reason"
        } else {
            &reason
        };
        return failed(why, &file);
    }
    let lost = if reason.is_empty() {
        Vec::new()
    } else {
        vec![format!(
            "the run directory (the record itself landed) — {reason}"
        )]
    };
    Filed {
        record: "filed".into(),
        file,
        lost,
    }
}

fn failed(why: &str, file: &str) -> Filed {
    Filed {
        record: "failed".into(),
        file: file.to_owned(),
        lost: vec![format!("the run record — {why}")],
    }
}

#[cfg(test)]
mod tests;
