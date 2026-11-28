//! Triage ends with a plan, never a review verdict or a substitute review record (#616).
use serde_json::Value;

use crate::run::drive::{Driver, Running, is_done};
use crate::run::ending::{Answer, Caught, Ending};
use crate::run::protocol::Protocol;
use crate::run::report::{said_section, text};

pub(crate) fn ended<P: Protocol>(d: &Driver<'_, P>, ending: Ending, r: &mut Running) -> Answer {
    let run = r.run.as_ref().map(|p| p.display().to_string());
    let why = match ending {
        Ending::Stopped(why, _) | Ending::Unrecorded(why) => why,
        Ending::Signalled(code, caught) => {
            let where_at = if matches!(caught, Caught::Starting(_)) {
                " while it started"
            } else {
                ""
            };
            format!("triage run was stopped by a signal (exit {code}){where_at}")
        }
        Ending::Finished(step) => return finished(d, step, r, run),
    };
    let hint = r.run.as_deref().map(|run| d.hint(run)).unwrap_or_default();
    Answer {
        text: format!(
            "Triage incomplete: {why}.\n\n{hint}\n\nNo terminal triage record was established.\n{}{}",
            said_section(&r.said),
            r.lost.section()
        ),
        finished: false,
        step: None,
        run,
    }
}

fn finished<P: Protocol>(
    d: &Driver<'_, P>,
    mut step: Value,
    r: &mut Running,
    run: Option<String>,
) -> Answer {
    let checked = craft_triage::step::outcome(&step);
    let (complete, body) = match checked {
        Ok(craft_triage::step::Outcome::Stopped(reason)) => {
            // A stale file named alongside a stop cannot become a plan result event.
            clear_plan(&mut step);
            (
                false,
                format!(
                    "Triage stopped: {reason}.\n\n{}",
                    r.run.as_deref().map(|p| d.hint(p)).unwrap_or_default()
                ),
            )
        }
        Ok(craft_triage::step::Outcome::Plan {
            complete,
            summary,
            notes,
        }) => {
            if let Some(o) = step.as_object_mut() {
                o.insert("summary".into(), Value::String(summary.clone()));
            }
            (
                complete,
                format!(
                    "The plan is {}.\n\n{summary}\n\n{}",
                    text(&step, "planFile"),
                    notes.join("\n")
                ),
            )
        }
        Err(e) => {
            clear_plan(&mut step);
            (false, format!("Triage incomplete: {e}"))
        }
    };
    let hint = if is_done(&step)
        && step.get("stopped").is_none()
        && step
            .get("filing")
            .is_some_and(|f| text(f, "record") != "filed")
    {
        format!(
            "\nThe run record can be filed again: {}.",
            (d.again)(text(&step, "run"))
        )
    } else {
        String::new()
    };
    Answer {
        text: format!("{body}\n\n{}{hint}", r.lost.section()),
        finished: complete,
        step: Some(step),
        run,
    }
}

fn clear_plan(step: &mut Value) {
    if let Some(o) = step.as_object_mut() {
        o.remove("planFile");
        o.remove("summary");
    }
}
