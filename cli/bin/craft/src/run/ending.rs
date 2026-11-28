//! How a driven run ends, and its answer (realm @nick/craft, nodes #40, #453): a finished run with
//! its telemetry notes, and — when its work was cut short or a round died whole — what the dead
//! agents said; a run the binary never finished, filed INCOMPLETE; a submit that failed, asked of
//! `status` whether it finished the run anyway.

use std::path::Path;

use serde_json::Value;

use super::drive::{Driver, Running, is_done, steps};
use super::protocol::{Lifecycle, Protocol, Said};
use craft_review::filing::{StopCause, UNFINISHED};

use super::report::{cut_short, finished_answer, resume_hint, said_section, stopped_answer, text};

/// How the loop ended.
#[derive(Debug)]
pub(crate) enum Ending {
    /// The binary's finished step.
    Finished(Value),
    /// The loop stopped before the binary finished the run: why, and its class for the record.
    Stopped(String, StopCause),
    /// A stopping signal ended the loop: the exit status it asks for, and where it caught the run.
    Signalled(u8, Caught),
    /// The binary finished the run but kept no finished step to file its record from.
    Unrecorded(String),
}

/// Where a stopping signal caught the run.
#[derive(Debug)]
pub(crate) enum Caught {
    /// Past its start (a round's tasks stopped, or a resume): a resume picks it up.
    Running,
    /// While the binary opened it, cutting it short; the start's own error when it failed.
    Starting(Option<String>),
}

/// The answer, and whether the run finished with its work whole.
#[derive(Debug)]
pub(crate) struct Answer {
    pub(crate) text: String,
    pub(crate) finished: bool,
    /// The finished step, when the binary finished the run.
    pub(crate) step: Option<Value>,
    /// The run directory, once the run had one.
    pub(crate) run: Option<String>,
}

/// `answer`, then each note that says something.
fn with_notes(answer: &str, notes: &[String]) -> String {
    let mut parts = vec![answer.to_owned()];
    parts.extend(notes.iter().filter(|n| !n.is_empty()).cloned());
    parts.join("\n\n")
}

/// The review: a finished run published on its PR, or the step loop to its end.
pub(crate) async fn drive<P: Protocol>(
    d: &Driver<'_, P>,
    resume: Option<&Path>,
    comment: bool,
) -> Answer {
    if let (Some(run), true) = (resume, comment) {
        return publish_after(d, run);
    }
    let mut r = Running::default();
    let ending = steps(d, resume, &mut r).await;
    ended(d, ending, &mut r)
}

fn publish_after<P: Protocol>(d: &Driver<'_, P>, run: &Path) -> Answer {
    let stopped = |why: String| Answer {
        text: stopped_answer(&why),
        finished: false,
        step: None,
        run: Some(run.display().to_string()),
    };
    match d.proto.comment(run) {
        Err(e) => stopped(format!(
            "the publication of {} did not finish: {e:#}",
            run.display()
        )),
        Ok(step) if !is_done(&step) => stopped("the binary answered with no finished run".into()),
        Ok(step) => {
            let mut r = Running::default();
            r.lost.heard(&step, &|l| d.log(l));
            let again = (d.again)(text(&step, "run"));
            Answer {
                text: with_notes(&finished_answer(&step, &again), &[r.lost.section()]),
                finished: true,
                run: Some(run.display().to_string()),
                step: Some(step),
            }
        }
    }
}

fn ended<P: Protocol>(d: &Driver<'_, P>, ending: Ending, r: &mut Running) -> Answer {
    if d.proto.lifecycle() == Lifecycle::Triage {
        return super::triage::ended(d, ending, r);
    }
    let log = |l: &str| d.log(l);
    let run = r.run.as_ref().map(|p| p.display().to_string());
    match ending {
        Ending::Finished(step) => {
            let cut = cut_short(text(&step, "verdict"));
            let said = if cut || r.all_died {
                said_section(&r.said)
            } else {
                String::new()
            };
            let again = (d.again)(text(&step, "run"));
            let notes = r.lost.settled(&step, &again, &log);
            Answer {
                text: with_notes(&finished_answer(&step, &again), &[said, notes]),
                finished: !cut,
                step: Some(step),
                run,
            }
        }
        Ending::Unrecorded(why) => {
            r.lost.note("the run record", &why, &log);
            let answer = stopped_answer(&format!("review lost the run's last step: {why}"));
            Answer {
                text: with_notes(&answer, &[said_section(&r.said), r.lost.section()]),
                finished: false,
                step: None,
                run,
            }
        }
        Ending::Signalled(code, caught) => signalled(d, code, &caught, r),
        Ending::Stopped(why, cause) => {
            let filed = r
                .run
                .as_deref()
                .and_then(|run| d.proto.unfinished(run, &[UNFINISHED, cause.note()]));
            for line in filed.into_iter().flatten() {
                r.lost.note_line(line, &log);
            }
            Answer {
                text: with_notes(
                    &stopped_answer(&why),
                    &[said_section(&r.said), r.lost.section()],
                ),
                finished: false,
                step: None,
                run,
            }
        }
    }
}

/// A start a stopping signal cut short: a resume would not prepare its gate, sources and consumers
/// list again (realm @nick/craft, node #544).
const FRESH: &str = "The start was cut short: its gate, sources and consumers list are incomplete, and a resume does not prepare them again. Start a fresh review: this command again, without `--run`.";

/// A run a stopping signal ended: filed INCOMPLETE with that reason, answered with how to resume —
/// or, for a stop during the start (with the start's own error when it failed), with a fresh
/// review.
fn signalled<P: Protocol>(d: &Driver<'_, P>, code: u8, caught: &Caught, r: &mut Running) -> Answer {
    let log = |l: &str| d.log(l);
    let stopped = format!("review run was stopped by a signal (exit {code})");
    let why = match caught {
        Caught::Running => stopped,
        Caught::Starting(None) => format!("{stopped} while it started"),
        Caught::Starting(Some(error)) => {
            format!("{stopped} while it started, and the start failed: {error}")
        }
    };
    let run = r.run.as_ref().map(|p| p.display().to_string());
    for line in r
        .run
        .as_deref()
        .and_then(|run| d.proto.unfinished(run, &[&why]))
        .into_iter()
        .flatten()
    {
        r.lost.note_line(line, &log);
    }
    let resume = match caught {
        Caught::Starting(_) => FRESH.to_owned(),
        Caught::Running => run
            .as_deref()
            .map(|run| resume_hint(run, &(d.again)(run)))
            .unwrap_or_default(),
    };
    Answer {
        text: with_notes(&stopped_answer(&why), &[resume, r.lost.section()]),
        finished: false,
        step: None,
        run,
    }
}

/// Where an unfinished run stands as `status` says it — `round N, phase P`, each only when named.
fn standing(status: &Value) -> String {
    let round = status
        .get("round")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .map(|n| format!("round {n}"));
    let phase = Some(text(status, "phase"))
        .filter(|p| !p.is_empty() && p.len() <= 60 && !p.chars().any(char::is_control))
        .map(|p| format!("phase {p}"));
    [round, phase]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(", ")
}

/// A submit whose step could not be read may still have finished the run: `status` is asked. A
/// finished run whose record did not land is filed again (`--resume`); one not finished is
/// reported where it stands.
pub(crate) fn recovered<P: Protocol>(
    d: &Driver<'_, P>,
    run: &Path,
    error: &str,
    r: &mut Running,
) -> Ending {
    if d.proto.lifecycle() == Lifecycle::Triage {
        return super::triage::recovered(d, run, error, r);
    }
    let status = d.proto.status(run).unwrap_or(Value::Null);
    let filing = status.get("filing").filter(|f| f.is_object());
    let finished = filing
        .and_then(|f| f.get("finished"))
        .filter(|f| f.is_object());
    let done = is_done(&status);
    let Some(finished) = finished else {
        if done && filing.is_some() {
            return Ending::Unrecorded(format!(
                "the craft binary finished the run ({}; its report is {}) but kept no finished step to file its record from, so the run store has no record of it",
                text(&status, "verdict"),
                text(&status, "report")
            ));
        }
        let at = standing(&status);
        let at = if at.is_empty() {
            String::new()
        } else {
            format!(" (the binary reports {at})")
        };
        return Ending::Stopped(
            format!(
                "review stopped{at}: {error}. The run is in {}. {}",
                run.display(),
                d.hint(run)
            ),
            StopCause::Step,
        );
    };
    let refile = done && filing.is_some_and(|f| text(f, "record") != "filed");
    let resume = Said {
        resume: true,
        ..Said::default()
    };
    let again = refile
        .then(|| d.proto.submit(run, &resume).ok())
        .flatten()
        .filter(is_done);
    let last = again.unwrap_or_else(|| finished.clone());
    d.log(&format!(
        "the run's last step could not be read; the binary says it ended: {}",
        text(&last, "verdict")
    ));
    r.lost.heard(&last, &|l| d.log(l));
    Ending::Finished(last)
}
