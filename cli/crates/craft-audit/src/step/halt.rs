//! An audit stopped on the account's usage limit and resumed, as the review and the triage stop
//! (`craft_step::stop`), and a finished audit resumed: a pass over what it left unread, or its
//! record filed again.

use std::path::Path;

use craft_review::filing::Writer;
use craft_step::Aside;
use serde_json::{Value, json};

use crate::AuditError;
use crate::plan;
use crate::state::AuditState;

use super::{advance, filing, finish, step};

/// What the host said of a step's tasks.
#[derive(Debug, Clone, Copy, Default)]
pub struct Said<'a> {
    /// How it ran them weaker than asked, one note each.
    pub degraded: &'a [String],
    /// The account's usage limit, as an agent's error or short answer said it: the run keeps the
    /// answers that came in and stops where it still needs agents, its pending tasks held.
    pub limit: Option<&'a str>,
    /// The host resumes a run: an answer missing now is handed out again, not counted; a finished
    /// run reads what it left unread, or files again a record that did not land.
    pub resume: bool,
    /// The tasks whose agents it abandoned at their deadline: failed at once, never handed out
    /// again in this pass.
    pub abandoned: &'a [String],
}

/// Stops the run on the host's limit `text`, its pending tasks held for a resume.
pub(super) fn on_limit(s: &mut AuditState, text: &str) {
    craft_step::stop::hold_pending(&mut s.tasks);
    s.stopped = Some(craft_step::stop::limit(text));
}

/// What the host said and the run noted, on a step or a status.
pub(super) fn said(out: &mut Value, s: &AuditState) {
    let Some(o) = out.as_object_mut() else { return };
    for (k, v) in [("degraded", &s.degraded), ("notes", &s.notes)] {
        if !v.is_empty() {
            o.insert(k.into(), json!(v));
        }
    }
    if let Some(stop) = &s.stopped {
        o.insert("stopped".into(), json!(stop));
    }
}

/// The step of the stopped run in `dir`: done for the host, with the stop and how to resume.
pub(super) fn stopped(dir: &Path, s: &AuditState) -> Value {
    let resume = craft_step::stop::resume("audit", dir);
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
    said(&mut out, s);
    out
}

/// A finished run submitted again: with `--resume`, a new pass over the jobs no task answered and
/// the findings whose verifier died, or, with nothing left, its record filed again when it records
/// and that record did not land; anything else is refused as done.
///
/// # Errors
/// [`AuditError::Done`], or as the pass or the run's end.
pub(super) fn finished_again(
    dir: &Path,
    s: &mut AuditState,
    said: &Said<'_>,
    w: &dyn Writer,
) -> Result<Value, AuditError> {
    if !said.resume {
        return Err(AuditError::Done(dir.to_owned()));
    }
    let profiles = crate::scout::profiles()?;
    let unread = !plan::unanswered(plan::jobs(&s.scout, &profiles), &s.tasks).is_empty();
    let unjudged = !crate::pool::unjudged(&crate::pool::pool(&s.tasks), &s.tasks).is_empty();
    if unread || unjudged {
        s.pass += 1;
        s.stopped = None;
        advance::open_pass(s, &profiles)?;
        return step(dir, s, Aside::default(), None, w);
    }
    if s.args.record.is_some() && !filing::filed(dir, s.pass) {
        return finish::end(dir, s, &profiles, w);
    }
    Err(AuditError::Done(dir.to_owned()))
}
