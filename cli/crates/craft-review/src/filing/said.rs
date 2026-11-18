//! What the run's telemetry says: after a step, as the step's `filing`, and to `status`.

use std::path::Path;

use serde_json::{Value, json};

use super::Filing;
use super::kept::load;

/// What the run's telemetry says of its record, for `status`: whether it is filed, its file, the
/// step the segment ended with as the host read it, with what its writes lost, and how many stopped
/// parts still wait for theirs; `None` when the run files no telemetry.
#[must_use]
pub fn summary(run: &Path) -> Option<Value> {
    let filing = load(run)?;
    let finished = filing
        .finished
        .clone()
        .map(|step| with_filing(step, outcome(run, &filing, &filing.lost, true)));
    Some(json!({
        "record": filing.record, "recordFile": filing.record_file, "finished": finished,
        "pending": filing.pending.len(),
    }))
}

/// What `summary` says without the step it keeps, for `status --brief`: whether the record is
/// filed, its file, whether the segment's finished step is kept, what the writes after the
/// segment's last step lost, and how many stopped parts wait —
/// a size no finding count grows (realm @nick/craft, node #522); `None` when the run files no
/// telemetry.
#[must_use]
pub fn brief(run: &Path) -> Option<Value> {
    let filing = load(run)?;
    Some(json!({
        "record": filing.record, "recordFile": filing.record_file,
        "kept": filing.finished.is_some(), "pending": filing.pending.len(),
        "lost": filing.lost,
    }))
}

/// `step` with the outcome of its telemetry under `filing`, its degraded notes saying whether its
/// record is filed.
#[must_use]
pub fn with_filing(mut step: Value, filing: Value) -> Value {
    if let Some(obj) = step.as_object_mut() {
        super::unfiled::tell(obj, &filing);
        obj.insert("filing".into(), filing);
    }
    step
}

/// What the writes after a step did, as the step's `filing` says it.
pub(super) fn outcome(run: &Path, filing: &Filing, lost: &[String], done: bool) -> Value {
    let mut v = json!({"runDir": filing.run_dir, "rejoin": filing.rejoin, "lost": lost});
    if let Some(obj) = v.as_object_mut().filter(|_| done) {
        obj.insert("record".into(), json!(filing.record));
        // A re-file names its file apart: the work it records was not this invocation's, so a later
        // run's cost is not enriched into it (lib/run-agents.mjs).
        let key = if filing.refiled {
            "refiledFile"
        } else {
            "recordFile"
        };
        if !filing.record_file.is_empty() {
            obj.insert(key.into(), json!(filing.record_file));
        }
        if let Some(note) = super::unfiled::note(run, filing, lost) {
            obj.insert("unfiled".into(), json!(note));
        }
    }
    v
}
