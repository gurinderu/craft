//! A triage stopped on the account's usage limit and resumed, as the review stops and resumes
//! (`craft_step::stop`; realm @nick/craft, nodes #300, #616): the stopped step names the stop and how
//! to go on, and a finished run whose record did not land is filed again by `--resume`.

use std::path::Path;

use craft_review::filing::Writer;
use serde_json::{Value, json};

use crate::TriageError;
use crate::state::TriageState;

use super::{advance, filing, finished};

/// What the host said of a step's tasks.
#[derive(Debug, Clone, Copy, Default)]
pub struct Said<'a> {
    /// How it ran them weaker than asked, one note each.
    pub degraded: &'a [String],
    /// The account's usage limit, as an agent's error or short answer said it: the run keeps the
    /// answers that came in and stops, its unanswered tasks held.
    pub limit: Option<&'a str>,
    /// The host resumes a run it lost: an answer missing now is handed out again, not counted
    /// as a failed attempt.
    pub resume: bool,
    /// The tasks whose agents it abandoned at their deadline: failed at once, never handed out
    /// again.
    pub abandoned: &'a [String],
}

/// Stops the run on the host's limit `text`, its pending tasks held for a resume; the tasks of the
/// phases it finished are left as they settled.
pub(super) fn on_limit(s: &mut TriageState, text: &str) {
    craft_step::stop::hold_pending(&mut s.tasks);
    s.stopped = Some(craft_step::stop::limit(text));
}

/// The step of the stopped run in `dir`: done for the host, with the stop, the line saying it and
/// how to resume.
pub(super) fn stopped(dir: &Path, s: &TriageState) -> Value {
    let resume = craft_step::stop::resume("triage", dir);
    let line = s.stopped.as_ref().map_or_else(String::new, |stop| {
        format!("{}. Resume {}: `{resume}`", stop.note(), stop.when())
    });
    let mut out = json!({
        "run": dir.display().to_string(),
        "done": true,
        "phase": s.phase,
        "line": line,
        "resume": resume,
    });
    finished::said(&mut out, s);
    out
}

/// A finished run submitted again: with `--resume`, a run that records and whose record is not
/// kept filed ends once more — its record filed as a retry, its plan built again from the same
/// answers —; any other is refused as done.
///
/// # Errors
/// [`TriageError::Done`], or as the run's end.
pub(super) fn finished_again(
    dir: &Path,
    s: &mut TriageState,
    said: &Said<'_>,
    w: &dyn Writer,
) -> Result<Value, TriageError> {
    let unfiled = s.args.record.is_some() && filing::read(dir).is_none_or(|f| f.record != "filed");
    if !said.resume || !unfiled {
        return Err(TriageError::Done(dir.to_owned()));
    }
    let Some(done) = advance(s)? else {
        return Err(TriageError::Done(dir.to_owned()));
    };
    let plan = finished::end(dir, s, &done, w)?;
    finished::step(dir, &plan, s)
}
