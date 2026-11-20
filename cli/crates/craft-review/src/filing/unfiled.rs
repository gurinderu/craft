//! A run whose record is not in the store says so where its reader looks, not only in its
//! telemetry's lost lines (realm @nick/craft, node #524): one note among how the run ran weaker
//! than asked — in its state, so its report, its finished step and its brief status carry it, and a
//! parent reads the run as degraded — with the command that files the record again. The note
//! follows the record: said while the last attempt failed, taken back once the record is filed.

use std::path::Path;

use serde_json::{Map, Value, json};

use super::{Filing, Record};
use crate::state::{self, Phase};

/// How every such note opens, so a later one replaces it.
const UNFILED: &str = "the run record is not filed";

/// The note the run's telemetry calls for now, `None` when its record is filed or not yet
/// attempted. `lost` is what its last writes lost, read before what the filing kept.
pub(super) fn note(run: &Path, filing: &Filing, lost: &[String]) -> Option<String> {
    let dir = run.display().to_string().replace('\'', r"'\''");
    if filing.record == Record::Failed {
        let why = lost
            .iter()
            .chain(&filing.lost)
            .find_map(|l| l.strip_prefix("the run record — "))
            .unwrap_or("its write failed");
        Some(format!(
            "{UNFILED} — {why}: file it again with `craft review submit --run '{dir}' --resume`"
        ))
    } else {
        None
    }
}

/// `notes` with any earlier such note replaced by `note`, or dropped when there is none.
fn retold(notes: &[String], note: Option<&str>) -> Vec<String> {
    notes
        .iter()
        .filter(|n| !n.starts_with(UNFILED))
        .cloned()
        .chain(note.map(str::to_owned))
        .collect()
}

/// The run's state retold with `note`, and the report of a finished run written again with it;
/// a write that fails is said in `lost`. A run with no state of this format is left alone.
pub(super) fn keep(run: &Path, note: Option<&str>, lost: &mut Vec<String>) {
    let Ok(mut state) = state::load(run) else {
        return;
    };
    let notes = retold(&state.degraded, note);
    if notes == state.degraded {
        return;
    }
    state.degraded = notes;
    let saved = state::save(run, &state).map_err(|e| e.to_string());
    let reported = saved.and_then(|()| {
        if state.phase == Phase::Done {
            crate::publish::write_report(run, &state).map_err(|e| e.to_string())
        } else {
            Ok(())
        }
    });
    if let Err(why) = reported {
        lost.push(format!("the note that the run record is not filed — {why}"));
    }
}

/// The finished `step`'s degraded notes retold with the note its `filing` carries (`unfiled`):
/// added, or taken back once the record is filed.
pub(super) fn tell(step: &mut Map<String, Value>, filing: &Value) {
    let note = filing.get("unfiled").and_then(Value::as_str);
    if note.is_none() && filing.get("record") != Some(&json!("filed")) {
        return;
    }
    let notes: Vec<String> = step
        .get("degraded")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let notes = retold(&notes, note);
    if notes.is_empty() {
        step.remove("degraded");
    } else {
        step.insert("degraded".into(), json!(notes));
    }
}
