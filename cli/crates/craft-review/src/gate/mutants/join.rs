//! The worker joined when the lens rounds end: its result read, or — past the wait — a stop asked
//! of it by a file it watches, so it stops cargo-mutants' group itself and no process id read from
//! disk is ever signalled on a guess; then the outcomes read as far as cargo-mutants got.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::super::lines::Lines;
use super::worker::{self, Came};
use super::{Mutants, findings, not_run, outcomes};

/// How long joining waits for a worker still running before it asks it to stop.
const JOIN_MAX: Duration = Duration::from_mins(2);
/// How long a worker asked to stop has to stop cargo-mutants and write its result.
const STOP_GRACE: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(200);

/// Joins a launched worker: waits at most `wait`, asks it to stop past that, and returns the
/// survivors' findings and the line the report says of the run. Nothing when none was launched.
/// A run that fell short of a whole answer is kept in [`Mutants::short`] as well.
pub(crate) fn join(m: &mut Mutants, wait: Duration) -> (Vec<Value>, Option<String>) {
    if !m.running() {
        return (Vec::new(), None);
    }
    m.joined = true;
    let (found, line, short) = joined(m, wait);
    if let (true, Some(line)) = (short, &line) {
        m.short.clone_from(line);
    }
    (found, line)
}

/// What a launched run came to, and whether it fell short of a whole answer.
fn joined(m: &Mutants, wait: Duration) -> (Vec<Value>, Option<String>, bool) {
    let dir = PathBuf::from(&m.dir);
    let came = wait_for(&dir, wait).or_else(|| stop(&dir));
    let read = std::fs::read_to_string(dir.join("mutants.out").join("outcomes.json"));
    let Ok(text) = read else {
        if matches!(came, Some(Came::NoMutants)) {
            return (Vec::new(), Some(NONE_IN_CHANGE.into()), false);
        }
        return (
            Vec::new(),
            Some(not_run(&why_none(came.as_ref(), &dir))),
            true,
        );
    };
    let lines = match crate::git::zero_context_diff(Path::new(&m.top), &m.base) {
        Ok(d) => Lines::parse(&d),
        Err(e) => {
            return (
                Vec::new(),
                Some(format!(
                    "mutants of the change wrote outcomes, but the change's lines could not be read ({e}): no survivor was kept"
                )),
                true,
            );
        }
    };
    let stopped = !matches!(came, Some(Came::Exited { .. }));
    match outcomes::parse(&text) {
        Ok(o) => said(&o, (&m.workspace, &dir), &lines, stopped),
        Err(e) => (
            Vec::new(),
            Some(format!(
                "mutants of the change ran, but their outcomes could not be read: outcomes.json: {e}"
            )),
            true,
        ),
    }
}

/// The line of a change in which cargo-mutants found no mutant: an answer, not a shortfall.
/// cargo-mutants says the same when the diff's paths miss the workspace root (node #624), so the
/// line names that check for a change that rewrote function bodies.
const NONE_IN_CHANGE: &str = "mutants of the change: cargo-mutants found no mutant in the change — if it rewrote function bodies, check the diff's paths against the workspace root (node #624)";

/// The join the rounds' end makes: [`JOIN_MAX`].
pub(crate) fn join_now(m: &mut Mutants) -> (Vec<Value>, Option<String>) {
    join(m, JOIN_MAX)
}

/// Stops a worker that was launched and never joined (the run ended before its rounds did).
pub(crate) fn abandon(m: &mut Mutants) {
    if m.running() {
        m.joined = true;
        let dir = PathBuf::from(&m.dir);
        if wait_for(&dir, Duration::ZERO).is_none() {
            stop(&dir);
        }
    }
}

/// Asks the worker to stop and waits [`STOP_GRACE`] for what it then wrote.
fn stop(dir: &Path) -> Option<Came> {
    if std::fs::write(dir.join(worker::STOP), "").is_err() {
        return None;
    }
    wait_for(dir, STOP_GRACE)
}

fn why_none(came: Option<&Came>, dir: &Path) -> String {
    match came {
        Some(Came::Missing) => "cargo-mutants is not installed where the gate's cargo runs".into(),
        Some(Came::TimedOut { secs }) => {
            format!("their budget ran out after {secs}s before any outcome")
        }
        Some(Came::Stopped) => "stopped at the join before cargo-mutants wrote anything".into(),
        Some(Came::NoMutants) => "cargo-mutants found no mutant in the change's lines".into(),
        Some(Came::Broken { message }) => message.clone(),
        Some(Came::Exited { code }) => format!("cargo-mutants exited ({code:?}) without outcomes"),
        None => {
            let log = dir.join(worker::ERR);
            let last =
                super::super::check::last_line(&std::fs::read_to_string(&log).unwrap_or_default());
            format!(
                "the worker wrote no result and did not answer a stop (its last word: {last}; its log: {})",
                log.display()
            )
        }
    }
}

/// What the run came to: the survivors kept, the report's line, and whether it fell short.
fn said(
    o: &outcomes::Outcomes,
    (workspace, dir): (&str, &Path),
    lines: &Lines,
    stopped: bool,
) -> (Vec<Value>, Option<String>, bool) {
    if !o.baseline_ok {
        let log = dir.join("mutants.out").join("log").join("baseline.log");
        let why = format!(
            "the unmutated workspace did not build or pass its tests in cargo-mutants' copy of it, so no mutant's outcome means anything — a crate that reads files outside its workspace fails there (realm @nick/craft, node #653); its log: {}",
            log.display()
        );
        return (Vec::new(), Some(not_run(&why)), true);
    }
    if o.total == 0 {
        return (Vec::new(), Some("mutants of the change: cargo-mutants chose none on a diff that touches Rust — check the diff's paths against the workspace root (node #624) before reading it as clean".into()), false);
    }
    let (found, neighbours) = findings::of(&o.missed, workspace, lines);
    let whole = o.complete && !stopped;
    let short = if whole {
        String::new()
    } else {
        format!(
            " — run short: {} of {} tested before it was stopped, the rest neither survived nor died",
            o.tested, o.total
        )
    };
    let left = if neighbours > 0 {
        format!(
            "; {neighbours} more survived in neighbouring functions the change did not touch, left out"
        )
    } else {
        String::new()
    };
    let line = format!(
        "mutants of the change: {} survived of {} tested ({} caught, {} timed out, {} unviable){left}{short}",
        found.len(),
        o.tested,
        o.caught,
        o.timeout,
        o.unviable
    );
    (found, Some(line), !whole)
}

/// The worker's result, once it wrote one within `wait`.
pub(super) fn wait_for(dir: &Path, wait: Duration) -> Option<Came> {
    let until = Instant::now() + wait;
    loop {
        if let Ok(text) = std::fs::read_to_string(dir.join(worker::RESULT)) {
            return serde_json::from_str(&text).ok();
        }
        if Instant::now() >= until {
            return None;
        }
        std::thread::sleep(POLL);
    }
}
