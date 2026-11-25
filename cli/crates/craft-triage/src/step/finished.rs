//! The finished run as the host receives it: the plan and the record, each written beside the
//! state with its keys in the engine's order, and the step naming them.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use craft_store::js::Js;

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

/// Writes the plan and the record of `done` into `dir`.
///
/// # Errors
/// When a file cannot be written.
pub(super) fn write(dir: &Path, done: &Finished) -> Result<(), TriageError> {
    for (path, v) in [
        (plan_path(dir), &done.plan),
        (record_path(dir), &done.record),
    ] {
        std::fs::write(&path, format!("{}\n", v.pretty()))
            .map_err(|source| TriageError::Unwritable { path, source })?;
    }
    Ok(())
}

/// `done` with the host's notes on how it ran tasks weaker than asked leading its plan: a banner,
/// a `DEGRADED:` lead on its summary and a `degraded` list, so the plan never reads as a full triage that was not one. A failed
/// plan (text) is left as it is; the step names the notes beside it.
pub(super) fn with_degraded(mut done: Finished, degraded: &[String]) -> Finished {
    let Js::Obj(o) = &mut done.plan else {
        return done;
    };
    if degraded.is_empty() {
        return done;
    }
    let mut lines =
        vec!["> **DEGRADED** — the host ran part of this triage weaker than asked:".to_owned()];
    lines.extend(degraded.iter().map(|d| format!("> - {d}")));
    lines.push(String::new());
    let body = field::or_empty(o, "plan_markdown");
    o.set(
        "plan_markdown",
        Js::str(format!("{}\n{body}", lines.join("\n"))),
    );
    let summary = format!(
        "DEGRADED: {}\n\n{}",
        degraded.join("; "),
        field::or_empty(o, "summary")
    );
    o.set("summary", Js::str(summary));
    o.set("degraded", field::texts(degraded));
    done
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

/// Where a finished run's plan and record are, so a host that lost the finished step reads them.
pub(super) fn files(out: &mut Value, dir: &Path) {
    if let Some(o) = out.as_object_mut() {
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
/// record are, and what the host said and the run noted.
///
/// # Errors
/// When the plan holds text JSON cannot carry (an unpaired surrogate).
pub(super) fn step(dir: &Path, done: &Finished, s: &TriageState) -> Result<Value, TriageError> {
    let plan = Value::try_from(&done.plan).map_err(|e| TriageError::PlanNotJson(e.to_string()))?;
    let mut out = json!({"run": dir.display().to_string(), "done": true, "plan": plan});
    files(&mut out, dir);
    said(&mut out, s);
    Ok(out)
}
