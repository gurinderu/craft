//! The finished run as the host receives it: the plan and the record, each written beside the
//! state with its keys in the engine's order, and the step naming them and what filing the record
//! did.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use craft_store::js::Js;

use craft_review::filing::Writer;

use crate::TriageError;
use crate::field;
use crate::run::Finished;
use crate::state::TriageState;

/// Where the finished run's plan is written.
#[must_use]
pub fn plan_path(dir: &Path) -> PathBuf {
    dir.join("plan.json")
}

/// Where the finished run's record is written.
#[must_use]
pub fn record_path(dir: &Path) -> PathBuf {
    dir.join("record.json")
}

/// The finished run's plan: its record filed first when the run records, so a record that did not
/// land leads the plan, then the host's degraded notes; both written beside the state.
///
/// # Errors
/// When the filing's outcome, the plan or the record cannot be written.
pub(super) fn end(
    dir: &Path,
    s: &TriageState,
    done: &Finished,
    w: &dyn Writer,
) -> Result<Js, TriageError> {
    let filed = super::filing::file(dir, s, &done.record, w)?;
    let lost = filed.map(|f| f.lost).unwrap_or_default();
    let lead = craft_store::lost::section(&lost);
    let plan = with_degraded(done.plan(&lost), &s.degraded, &lead);
    write(dir, &plan, &done.record)?;
    Ok(plan)
}

/// Writes the finished run's `plan` and `record` into `dir`.
///
/// # Errors
/// When a file cannot be written.
fn write(dir: &Path, plan: &Js, record: &Js) -> Result<(), TriageError> {
    for (path, v) in [(plan_path(dir), plan), (record_path(dir), record)] {
        std::fs::write(&path, format!("{}\n", v.pretty()))
            .map_err(|source| TriageError::Unwritable { path, source })?;
    }
    Ok(())
}

/// `plan` with the host's notes on how it ran tasks weaker than asked leading it, below `lead` — the
/// section of a write that did not land, which leads every plan: a banner, a `DEGRADED:` lead on
/// its summary and a `degraded` list, so the plan never reads as a full triage that was not one. A
/// failed plan (text) is left as it is; the step names the notes beside it.
fn with_degraded(mut plan: Js, degraded: &[String], lead: &str) -> Js {
    let Js::Obj(o) = &mut plan else {
        return plan;
    };
    if degraded.is_empty() {
        return plan;
    }
    let mut lines =
        vec!["> **DEGRADED** — the host ran part of this triage weaker than asked:".to_owned()];
    lines.extend(degraded.iter().map(|d| format!("> - {d}")));
    lines.push(String::new());
    let body = field::or_empty(o, "plan_markdown");
    let (top, rest) = body
        .strip_prefix(lead)
        .map_or(("", body.as_str()), |rest| (lead, rest));
    o.set(
        "plan_markdown",
        Js::str(format!("{top}{}\n{rest}", lines.join("\n"))),
    );
    let summary = format!(
        "DEGRADED: {}\n\n{}",
        degraded.join("; "),
        field::or_empty(o, "summary")
    );
    o.set("summary", Js::str(summary));
    o.set("degraded", field::texts(degraded));
    plan
}

/// What the host said and what the run noted, on a step or a status: `degraded`, `notes`.
pub(super) fn said(out: &mut Value, s: &TriageState) {
    let Some(o) = out.as_object_mut() else { return };
    for (k, v) in [("degraded", &s.degraded), ("notes", &s.notes)] {
        if !v.is_empty() {
            o.insert(k.into(), json!(v));
        }
    }
}

/// Where a finished run's plan and record are, so a host that lost the finished step reads them,
/// and what filing the record did when the run recorded.
pub(super) fn files(out: &mut Value, dir: &Path) {
    if let Some(o) = out.as_object_mut() {
        if let Some(filed) = super::filing::read(dir) {
            o.insert("filing".into(), json!(filed));
        }
        o.insert(
            "planFile".into(),
            json!(plan_path(dir).display().to_string()),
        );
        o.insert(
            "recordFile".into(),
            json!(record_path(dir).display().to_string()),
        );
    }
}

/// The finished step: the plan (its file holds its keys in the engine's order), where it and the
/// record are, what filing the record did, and what the host said and the run noted.
///
/// # Errors
/// When the plan holds text JSON cannot carry (an unpaired surrogate).
pub(super) fn step(dir: &Path, plan: &Js, s: &TriageState) -> Result<Value, TriageError> {
    let plan = Value::try_from(plan).map_err(|e| TriageError::PlanNotJson(e.to_string()))?;
    let mut out = json!({"run": dir.display().to_string(), "done": true, "plan": plan});
    files(&mut out, dir);
    said(&mut out, s);
    Ok(out)
}
