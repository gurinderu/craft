//! A finished pass as the host receives it: its record filed first when the run records, so a
//! record that did not land leads the report; then the report, the record, the unread paths and
//! the unverified Low and Info findings, each written into the run directory, and the step naming
//! them, kept in `finished.json` for a host that lost it.

use std::path::{Path, PathBuf};

use craft_review::filing::Writer;
use craft_review::profile::Profile;
use serde_json::{Value, json};

use crate::AuditError;
use crate::report::{self, Summary, UNREAD, UNVERIFIED};
use crate::state::AuditState;

use super::{filing, halt};

/// Where the finished pass's report is written.
#[must_use]
pub fn report_path(dir: &Path) -> PathBuf {
    dir.join("report.md")
}

/// Where its record is written.
#[must_use]
pub fn record_path(dir: &Path) -> PathBuf {
    dir.join("record.json")
}

/// Where the paths it left unread are listed, one a line.
#[must_use]
pub fn unread_path(dir: &Path) -> PathBuf {
    dir.join(UNREAD)
}

/// Where its unverified Low and Info findings are listed.
#[must_use]
pub fn unverified_path(dir: &Path) -> PathBuf {
    dir.join(UNVERIFIED)
}

/// Where its finished step is kept.
#[must_use]
pub fn finished_path(dir: &Path) -> PathBuf {
    dir.join("finished.json")
}

fn write(path: PathBuf, text: &str) -> Result<(), AuditError> {
    std::fs::write(&path, text).map_err(|source| AuditError::Unwritable { path, source })
}

/// `text` at `path` when there is any, else no file there: a later pass that read all removes
/// the list an earlier one left.
fn list(path: PathBuf, text: Option<String>) -> Result<(), AuditError> {
    if let Some(t) = text {
        return write(path, &t);
    }
    drop(std::fs::remove_file(&path));
    Ok(())
}

fn held(sum: &Summary) -> Option<String> {
    let mut held = sum.held();
    if held.is_empty() {
        return None;
    }
    held.sort_by_key(|f| f.get("severity").and_then(Value::as_str) != Some("Low"));
    let mut out = String::from(
        "# Unverified Low and Info findings\n\nNo verifier checked these against the code.\n\n",
    );
    out.extend(held.into_iter().map(report::markdown::entry));
    Some(out)
}

/// Ends the pass of `s` in `dir`: files its record, writes what it says, and returns its step.
///
/// # Errors
/// When the filing's attempt or a file cannot be written.
pub(super) fn end(
    dir: &Path,
    s: &AuditState,
    profiles: &[Profile],
    w: &dyn Writer,
) -> Result<Value, AuditError> {
    let sum = report::summary(s, profiles);
    let record = crate::record::run_record(s, &sum);
    let filed = filing::file(dir, s, &record, w)?;
    let lost = filed.as_ref().map(|f| f.lost.clone()).unwrap_or_default();
    write(report_path(dir), &report::markdown(dir, s, &sum, &lost))?;
    write(record_path(dir), &format!("{record:#}\n"))?;
    let unread = (!sum.unread.is_empty()).then(|| format!("{}\n", sum.unread.join("\n")));
    list(unread_path(dir), unread)?;
    list(unverified_path(dir), held(&sum))?;
    if let Some(f) = &filed {
        filing::keep(dir, f)?;
    }
    let out = step(dir, s, &sum, filed.as_ref());
    write(finished_path(dir), &format!("{out:#}\n"))?;
    Ok(out)
}

/// The finished step: the verdict, where the report and record are, what is unread and how to
/// read it, the held findings, what filing the record did, and what the host said.
fn step(dir: &Path, s: &AuditState, sum: &Summary, filed: Option<&filing::Filed>) -> Value {
    let path = |p: PathBuf| p.display().to_string();
    let mut out = json!({
        "run": path(dir.to_owned()),
        "done": true,
        "phase": s.phase,
        "pass": s.pass,
        "verdict": sum.verdict,
        "report": path(report_path(dir)),
        "recordFile": path(record_path(dir)),
    });
    let Some(o) = out.as_object_mut() else {
        return out;
    };
    if !sum.unread.is_empty() {
        o.insert(
            "unread".into(),
            json!({"count": sum.unread.len(), "file": path(unread_path(dir))}),
        );
    }
    if sum.unjudged() > 0 {
        o.insert("unjudged".into(), json!(sum.unjudged()));
    }
    if !sum.unread.is_empty() || sum.unjudged() > 0 {
        o.insert(
            "resume".into(),
            json!(craft_step::stop::resume("audit", dir)),
        );
    }
    let held = sum.held().len();
    if held > 0 {
        o.insert(
            "unverifiedLow".into(),
            json!({"count": held, "file": path(unverified_path(dir))}),
        );
    }
    if let Some(f) = filed {
        o.insert("filing".into(), json!(f));
    }
    halt::said(&mut out, s);
    out
}
