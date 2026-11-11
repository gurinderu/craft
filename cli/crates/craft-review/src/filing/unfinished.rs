//! The record of a run its host stopped driving before the binary finished it — `craft review run`
//! stopped by a host that is not logged in, by its rounds' backstop, or by a step it could not
//! read (realm @nick/craft, nodes #40, #499): INCOMPLETE, with why in `notRun`, filed into the
//! segment's checkpoints as a finished run's record is.

use std::path::Path;

use serde_json::json;

use super::kept::load;
use super::{Record, Writer, file_record, keep};

/// Files the INCOMPLETE record of the run in `run`, stopped for `why`; the lines of what did not
/// land. `None` when the run files no telemetry, or its segment's record was attempted already
/// (the binary filed the run's end itself).
pub fn unfinished(run: &Path, why: &str, w: &dyn Writer) -> Option<Vec<String>> {
    let mut filing = load(run)?;
    if filing.finished.is_some() || filing.record != Record::None {
        return None;
    }
    let step = json!({
        "run": run.display().to_string(), "done": true,
        "report": run.join("report.md").display().to_string(),
        "verdict": "INCOMPLETE", "line": "", "notRun": [why], "findings": [],
        "repo": filing.ctx.repo,
    });
    let mut lost = Vec::new();
    file_record(run, &mut filing, &step, &mut lost, w);
    keep(run, &mut filing, &mut lost);
    Some(lost)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use serde_json::Value;

    use super::super::{Call, Ctx, NodeWriter, WriteError, open};
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
            unfinished(run.path(), "pi is not logged in", &w),
            Some(vec![])
        );
        let calls = w.0.borrow();
        let (command, request) = calls.last().unwrap();
        assert_eq!(command, "finalize");
        assert_eq!(request["step"]["verdict"], json!("INCOMPLETE"));
        assert_eq!(request["step"]["notRun"], json!(["pi is not logged in"]));
        assert_eq!(request["step"]["repo"], json!("/r"));
        drop(calls);
        assert_eq!(unfinished(run.path(), "again", &w), None);
    }

    #[test]
    fn a_run_that_files_no_telemetry_is_left_alone() {
        let run = tempfile::tempdir().unwrap();
        assert_eq!(unfinished(run.path(), "why", &NodeWriter), None);
    }
}
