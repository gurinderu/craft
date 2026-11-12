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
        .map(|step| with_filing(step, outcome(&filing, &filing.lost, true)));
    Some(json!({
        "record": filing.record, "recordFile": filing.record_file, "finished": finished,
        "pending": filing.pending.len(),
    }))
}

/// `step` with the outcome of its telemetry under `filing`.
#[must_use]
pub fn with_filing(mut step: Value, filing: Value) -> Value {
    if let Some(obj) = step.as_object_mut() {
        obj.insert("filing".into(), filing);
    }
    step
}

/// What the writes after a step did, as the step's `filing` says it.
pub(super) fn outcome(filing: &Filing, lost: &[String], done: bool) -> Value {
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
    }
    v
}
