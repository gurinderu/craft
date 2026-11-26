//! The finished run's record filed in the store by the binary (`start --record`; realm @nick/craft,
//! node #616): the attempt is marked before the write, and what it did is kept, atomically, once
//! the plan and record it leads are written ([`keep`]). A run that finishes again files nothing
//! more once its filing is kept `filed`; any other — an attempt kept alone, or a filing kept
//! `failed` — goes out again as a retry, which the store answers `already filed` when the first
//! landed. A write that did not land is one line of `lost`, `<what> — <why>`, as
//! `triage-findings.js` notes it.

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

/// Files `record` for the run in `dir` when it records, the attempt kept first, and returns what
/// the filing did for the caller to [`keep`]; `None` when it does not record.
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
    if let Some(kept) = read(dir).filter(|f| f.record == "filed") {
        return Ok(Some(kept));
    }
    let retry = filing_path(dir).exists();
    let attempted = Filed {
        record: "attempted".into(),
        ..Filed::default()
    };
    keep(dir, &attempted)?;
    let filed = match Value::try_from(record) {
        Ok(rec) => answered(send(dir, s, at, &rec, retry, w)),
        Err(e) => failed(&format!("the record holds text JSON cannot carry: {e}"), ""),
    };
    Ok(Some(filed))
}

/// What the run's filing did, when it filed.
#[must_use]
pub fn read(dir: &Path) -> Option<Filed> {
    let text = std::fs::read_to_string(filing_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Keeps what the filing did beside the state, once the plan and record it leads are written: a
/// run that fails before has only its attempt kept, and finishing again files it as a retry.
///
/// # Errors
/// When it cannot be written.
pub(super) fn keep(dir: &Path, filed: &Filed) -> Result<(), TriageError> {
    let path = filing_path(dir);
    let text = serde_json::to_string_pretty(filed).unwrap_or_default();
    craft_store::write::write_atomically(&path, format!("{text}\n")).map_err(|e| {
        TriageError::Unwritable {
            path,
            source: std::io::Error::other(e.to_string()),
        }
    })
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
