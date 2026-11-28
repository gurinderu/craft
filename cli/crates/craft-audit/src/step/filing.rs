//! A finished pass's record filed in the store by the binary (`start --record`), as the triage files
//! its own (`craft_store`'s `record` write): the attempt is kept before the write, and what it did
//! once the report it leads is written. A pass whose filing is kept `filed` files nothing more; any
//! other filing of it goes out again as a retry, which the store answers `already filed` when the
//! first landed. A write that did not land is one line of `lost`, `<what> — <why>`.

use std::path::{Path, PathBuf};

use craft_review::filing::{Call, WriteError, Writer};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::AuditError;
use crate::state::AuditState;

/// Where the run keeps what its filing did.
#[must_use]
pub fn filing_path(dir: &Path) -> PathBuf {
    dir.join("filing.json")
}

/// What the filing of a pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Filed {
    /// The pass whose record it is.
    pub pass: u32,
    /// `filed` or `failed`; `attempted` until the write answered and the report it leads is written.
    pub record: String,
    pub file: String,
    pub lost: Vec<String>,
}

/// What the run's filing did last.
#[must_use]
pub fn read(dir: &Path) -> Option<Filed> {
    serde_json::from_str(&std::fs::read_to_string(filing_path(dir)).ok()?).ok()
}

/// Whether the record of `pass` landed.
#[must_use]
pub fn filed(dir: &Path, pass: u32) -> bool {
    read(dir).is_some_and(|f| f.pass == pass && f.record == "filed")
}

/// Files `record` for the run in `dir` when it records, the attempt kept first, and returns what
/// the filing did for the caller to [`keep`]; `None` when it does not record.
///
/// # Errors
/// When the attempt cannot be kept beside the state.
pub(super) fn file(
    dir: &Path,
    s: &AuditState,
    record: &Value,
    w: &dyn Writer,
) -> Result<Option<Filed>, AuditError> {
    let Some(at) = &s.args.record else {
        return Ok(None);
    };
    if let Some(kept) = read(dir).filter(|f| f.pass == s.pass && f.record == "filed") {
        return Ok(Some(kept));
    }
    let retry = read(dir).is_some_and(|f| f.pass == s.pass);
    let base = Filed {
        pass: s.pass,
        ..Filed::default()
    };
    keep(
        dir,
        &Filed {
            record: "attempted".into(),
            ..base.clone()
        },
    )?;
    let request = json!({
        "repo": s.cwd.display().to_string(),
        "session": at.session,
        "record": record,
        "retry": retry,
    });
    let got = w.write(&Call {
        run: dir,
        root: &at.root,
        command: "record",
        request: &request,
    });
    Ok(Some(answered(&base, got)))
}

/// Keeps what the filing did beside the state.
///
/// # Errors
/// When it cannot be written.
pub(super) fn keep(dir: &Path, filed: &Filed) -> Result<(), AuditError> {
    let path = filing_path(dir);
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(filed).unwrap_or_default()
    );
    std::fs::write(&path, text).map_err(|source| AuditError::Unwritable { path, source })
}

/// The writer's `{ ok, reason, file }`, or why it gave none.
fn answered(base: &Filed, got: Result<Value, WriteError>) -> Filed {
    let failed = |why: &str, file: &str| Filed {
        record: "failed".into(),
        file: file.to_owned(),
        lost: vec![format!("the run record — {why}")],
        ..base.clone()
    };
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
        ..base.clone()
    }
}

#[cfg(test)]
mod tests;
