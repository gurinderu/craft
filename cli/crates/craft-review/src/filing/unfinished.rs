//! The record of a run its host stopped driving before the binary finished it — `craft review run`
//! stopped by a host that is not logged in, by its rounds' backstop, or by a step it could not
//! read (realm @nick/craft, nodes #40, #499): INCOMPLETE, with why in `notRun` and the round,
//! scope and base its state holds, filed into the segment's checkpoints as a finished run's
//! record is.

use std::path::Path;

use serde_json::json;

use super::kept::load;
use super::{Record, Writer, file_record, keep};

/// The `notRun` line of a run its driver stopped before the binary finished it; the cause's line
/// follows it ([`StopCause::note`]).
pub const UNFINISHED: &str = "the craft binary did not finish the run";

/// Why the driver stopped a run the binary had not finished (realm @nick/craft, node #638): a
/// class, so the run store counts each cause as one row (`notRun` is tallied by exact line), the
/// same lines the Claude Code driver files (`content/parity/stop-causes.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopCause {
    /// The run could not be started or resumed.
    Start,
    /// The host could not run the tasks: not logged in, or not in the run's checkout.
    Host,
    /// A step of the binary could not be read or handed in.
    Step,
    /// The driver's round backstop was reached.
    Rounds,
}

impl StopCause {
    /// The cause's `notRun` line.
    #[must_use]
    pub const fn note(self) -> &'static str {
        match self {
            Self::Start => "stopped: the run could not start or resume",
            Self::Host => "stopped: the host could not run the tasks",
            Self::Step => "stopped: a step of the binary was lost",
            Self::Rounds => "stopped: the driver's round backstop was reached",
        }
    }
}

/// Files the INCOMPLETE record of the run in `run`, its `notRun` lines saying why it stopped; the
/// lines of what did not land. `None` when the run files no telemetry, or its segment's record was
/// attempted already (the binary filed the run's end itself).
pub fn unfinished(run: &Path, not_run: &[&str], w: &dyn Writer) -> Option<Vec<String>> {
    let mut filing = load(run)?;
    if filing.finished.is_some() || filing.record != Record::None {
        return None;
    }
    let mut step = json!({
        "run": run.display().to_string(), "done": true,
        "report": run.join("report.md").display().to_string(),
        "verdict": "INCOMPLETE", "line": "", "notRun": not_run, "findings": [],
        "repo": filing.ctx.repo,
    });
    // What the state holds of where the run stood; a state that cannot be read leaves the record
    // a first review's, as before.
    if let Ok(state) = crate::state::load(run) {
        crate::finished::name_chain(&mut step, &state);
    }
    let mut lost = Vec::new();
    file_record(run, &mut filing, &step, &mut lost, w);
    keep(run, &mut filing, &mut lost);
    Some(lost)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use serde_json::Value;

    use super::super::{Call, Ctx, StoreWriter, WriteError, open};
    use super::*;

    /// Keeps each call and answers it landed.
    #[derive(Default)]
    struct Kept(RefCell<Vec<(String, Value)>>);

    impl Writer for Kept {
        fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
            self.0
                .borrow_mut()
                .push((call.command.to_owned(), call.request.clone()));
            Ok(json!({"ok": true, "reason": "", "file": "/store/r.json", "runDir": "/store/d"}))
        }
    }

    fn ctx() -> Ctx {
        Ctx {
            repo: "/r".into(),
            root: Some("/plugin".into()),
            craft_version: "0.50.0".into(),
            ..Ctx::default()
        }
    }

    #[test]
    fn a_stopped_run_is_filed_incomplete_once_with_why() {
        let run = tempfile::tempdir().unwrap();
        let w = Kept::default();
        let step = json!({"run": "/run", "done": false, "tasks": [], "phase": "scout"});
        open(run.path(), ctx(), "", &step, &w);
        assert_eq!(
            unfinished(run.path(), &["pi is not logged in"], &w),
            Some(vec![])
        );
        let calls = w.0.borrow();
        let (command, request) = calls.last().unwrap();
        assert_eq!(command, "finalize");
        assert_eq!(request["step"]["verdict"], json!("INCOMPLETE"));
        assert_eq!(request["step"]["notRun"], json!(["pi is not logged in"]));
        assert_eq!(request["step"]["repo"], json!("/r"));
        drop(calls);
        assert_eq!(unfinished(run.path(), &["again"], &w), None);
    }

    #[test]
    fn a_stopped_run_names_the_round_scope_and_base_its_state_holds() {
        let run = tempfile::tempdir().unwrap();
        let state: crate::state::RunState = serde_json::from_value(json!({
            "version": crate::state::STATE_VERSION,
            "context": {"repo": "/r", "base": "b264e96a", "spec": "", "craftRoot": null, "craftVersion": null},
            "diff": {"base": "b264e96a", "mergeBase": "m", "head": "h", "dirty": false, "files": [], "stat": "", "log": ""},
            "tracks": [], "light": false, "delta": true, "phase": "lenses", "tasks": [],
            "rounds": {"round": 1, "pool": [], "yields": [], "expected": [], "returned": [], "failures": {}},
            "findings": [], "settled": [], "notes": [], "notRun": [],
            "chain": {"round": 2, "base": "ba2804eb"}
        }))
        .unwrap();
        crate::state::save(run.path(), &state).unwrap();
        let w = Kept::default();
        let step = json!({"run": "/run", "done": false, "tasks": [], "phase": "lenses"});
        open(run.path(), ctx(), "", &step, &w);
        unfinished(run.path(), &["stopped"], &w);
        let calls = w.0.borrow();
        let asked = &calls.last().unwrap().1["step"];
        assert_eq!(
            (
                &asked["round"],
                &asked["lensScope"],
                &asked["base"],
                &asked["head"]
            ),
            (&json!(2), &json!("delta"), &json!("ba2804eb"), &json!("h")),
            "the record of a stopped round 2 says round 2, not a first full review"
        );
    }

    #[test]
    fn a_run_that_files_no_telemetry_is_left_alone() {
        let run = tempfile::tempdir().unwrap();
        assert_eq!(
            unfinished(run.path(), &["why"], &StoreWriter::default()),
            None
        );
    }

    /// The lines are the ones the Claude Code driver files too (realm @nick/craft, node #638).
    #[test]
    fn the_cause_lines_are_the_parity_files() {
        let parity: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../content/parity/stop-causes.json"
        )))
        .unwrap();
        assert_eq!(parity["unfinished"], json!(UNFINISHED));
        for (key, cause) in [
            ("start", StopCause::Start),
            ("host", StopCause::Host),
            ("step", StopCause::Step),
            ("rounds", StopCause::Rounds),
        ] {
            assert_eq!(parity["causes"][key], json!(cause.note()), "{key}");
        }
    }
}
