//! Stopping a run on the account's usage limit (realm @nick/craft, nodes #299, #300), as
//! `integrations/shared/usage-limit.mjs` stops the engines: every dispatch after a limit fails the same way until
//! it resets, so a run that keeps handing out tasks spends them on agents that cannot answer.
//!
//! Two stops. The host saw the limit's own text — an agent's error or short answer — and says so on
//! `submit` (`--limit`): the run stops at once, the answers that did come in kept. Or a dispatch
//! round — a lens round, the verification, as the engine's `limitStop.round` opens them — settled
//! with every task in it dead after its retries, no live answer at all. The host says what each dead
//! agent last wrote (`--died`), and the stop names what most of them said (realm @nick/craft, node
//! #666); where none said anything it is most likely the limit or an outage. A transient rate limit
//! is neither: its agent dies alone and is asked for again.
//!
//! A stopped run is not done: its report says INCOMPLETE with why and how to resume, its unanswered
//! tasks are held as they were first handed out, and the next `submit` without `--limit` hands them
//! out again.

use craft_store::js::JsStr;
use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::Error;
use crate::finished;
use crate::report;
use crate::state::{self, Phase, RunState, TaskState};
use crate::step::StepError;

/// How much of the host's limit text the run keeps, as `usageLimitText` cuts it.
const LIMIT_TEXT_MAX: usize = 200;
/// What a dead round most likely was, as the engines say it, when no dead agent said why.
const DEATHS_LIKELY: &str = "most likely the account's usage limit or an outage";
/// How many of the dead agents' lines a stop names, the most said first.
const SAID_SHOWN: usize = 3;

/// What stopped the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cause {
    /// The host saw the limit's text.
    Limit,
    /// A whole dispatch round died with no answer.
    Deaths,
}

/// The run's stop: its cause and what it saw.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stop {
    pub cause: Cause,
    pub text: String,
    /// The text names what the dead agents said, so no guess follows it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub told: bool,
}

impl Stop {
    /// The stop as a parent reads it back from a report (`limitInReport`, `deathsInReport` in
    /// `integrations/shared/limit-report.mjs`).
    #[must_use]
    pub fn note(&self) -> String {
        match self.cause {
            Cause::Limit => format!("stopped: usage limit reached ({})", self.text),
            Cause::Deaths if self.told => format!("stopped: {}", self.text),
            Cause::Deaths => format!("stopped: {}, {DEATHS_LIKELY}", self.text),
        }
    }
}

/// The dispatch round the run is in and whether any task of it answered: a lens round, the
/// verification (all its waves one round, as the engine watches it), or none — the scouts, the dedup and the judges are single
/// steps whose death the run already reports, as the engine leaves them out of its rounds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Watch {
    pub round: Option<String>,
    pub live: bool,
    /// What each of the round's dead agents last wrote, by its task's id, each line with its ids
    /// folded: a task asked again keeps only its last.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub said: BTreeMap<String, String>,
}

/// The dispatch round the run's pending tasks belong to.
fn round_of(run: &RunState) -> Option<String> {
    match run.phase {
        Phase::Lenses => Some(format!("lens round {}", run.rounds.round)),
        Phase::Verify => Some("the verification".into()),
        Phase::Scout
        | Phase::RedTeam
        | Phase::Seam
        | Phase::Dedup
        | Phase::Match
        | Phase::Rules
        | Phase::Critic
        | Phase::CriticLenses
        | Phase::Done => None,
    }
}

/// Opens the watch on the round this submit answers, a new one when the round changed.
pub(crate) fn open(run: &mut RunState) {
    let round = round_of(run);
    if run.watch.round != round {
        run.watch = Watch {
            round,
            ..Watch::default()
        };
    }
}

/// Keeps what this submit's dead agents last wrote (`died`, each `<task id>=<line>`) for the
/// round's stop; an entry with no `=` or no line is passed over.
pub(crate) fn hear(run: &mut RunState, died: &[String]) {
    for (id, line) in died.iter().filter_map(|d| d.split_once('=')) {
        let line = folded(line);
        if !id.is_empty() && !line.is_empty() {
            run.watch.said.insert(id.to_owned(), line);
        }
    }
}

/// `line` as one line, capped, each id in it — a run of 8 or more hex digits and dashes, as a
/// request id or a UUID is — folded to `…`, so the agents that said one thing count together.
fn folded(line: &str) -> String {
    let one = line.js_split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    let mut id = String::new();
    let flush = |id: &mut String, out: &mut String| {
        if id.chars().filter(char::is_ascii_hexdigit).count() >= 8 {
            out.push('…');
        } else {
            out.push_str(id);
        }
        id.clear();
    };
    for c in one.chars() {
        if c.is_ascii_hexdigit() || c == '-' {
            id.push(c);
        } else {
            flush(&mut id, &mut out);
            out.push(c);
        }
    }
    flush(&mut id, &mut out);
    out.chars().take(LIMIT_TEXT_MAX).collect()
}

/// What the dead agents said, the most said first: `` N said `line` ``, joined.
fn said_of(said: &BTreeMap<String, String>) -> Option<String> {
    let mut counts: BTreeMap<&String, u32> = BTreeMap::new();
    for line in said.values() {
        *counts.entry(line).or_default() += 1;
    }
    let mut lines: Vec<(&String, u32)> = counts.into_iter().collect();
    lines.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let shown: Vec<String> = lines
        .into_iter()
        .take(SAID_SHOWN)
        .map(|(l, n)| format!("{n} said `{}`", l.replace('`', "'")))
        .collect();
    (!shown.is_empty()).then(|| shown.join(", "))
}

/// Whether the round settled with every task in it dead: none pending, none answered alive. A task
/// the host abandoned at its deadline was a live agent that took too long, as the engine reads a
/// deadline fire (`integrations/shared/usage-limit.mjs`, realm @nick/craft, #299): a round with one is not dead, and
/// goes on with its failed tasks.
pub(crate) fn round_died(run: &RunState) -> Option<Stop> {
    let settled = run.tasks.iter().all(|t| t.state != TaskState::Pending);
    let dead = !run.tasks.is_empty() && !run.tasks.iter().any(|t| t.abandoned);
    if !settled || !dead || run.watch.live {
        return None;
    }
    let r = run.watch.round.as_ref()?;
    let text = format!("every agent dispatched in {r} died with no answer");
    Some(match said_of(&run.watch.said) {
        Some(said) => Stop {
            cause: Cause::Deaths,
            text: format!("{text}; of {} agent(s), {said}", run.tasks.len()),
            told: true,
        },
        None => deaths(text),
    })
}

/// The host's limit text as one line, capped.
#[must_use]
pub fn limit(text: &str) -> Stop {
    let one = text.js_split_whitespace().collect::<Vec<_>>().join(" ");
    Stop {
        cause: Cause::Limit,
        text: one.chars().take(LIMIT_TEXT_MAX).collect(),
        told: false,
    }
}

/// A stop on a dead round.
#[must_use]
pub fn deaths(text: String) -> Stop {
    Stop {
        cause: Cause::Deaths,
        text,
        told: false,
    }
}

/// Stops the run: every task not answered is held as first handed out, to be handed out again —
/// but one abandoned at its deadline, which stays failed. Its counted refused file (`counted`) is
/// kept, so one still in place is not read as a new answer on the resume.
pub(crate) fn hold(run: &mut RunState, stop: Stop) {
    for t in run
        .tasks
        .iter_mut()
        .filter(|t| t.state != TaskState::Answered && !t.abandoned)
    {
        t.state = TaskState::Pending;
        t.retries = 0;
        t.error = None;
        t.refused = None;
        // `counted` stays: a refused file still in place is no new answer on the resume.
    }
    run.watch = Watch::default();
    run.stopped = Some(stop);
}

/// How to resume the run in `dir`.
fn resume(dir: &Path) -> String {
    let d = dir.display().to_string().replace('\'', r"'\''");
    format!("craft review submit --run '{d}' --resume")
}

/// The step of the stopped run in `dir`: done for the host, INCOMPLETE, its report written with
/// what it has, the stop and how to resume it.
///
/// # Errors
/// When the report cannot be written.
pub(crate) fn step(dir: &Path, run: &RunState) -> Result<Value, Error> {
    let Some(stop) = &run.stopped else {
        return Ok(Value::Null);
    };
    let when = match stop.cause {
        Cause::Limit => "once the limit resets",
        Cause::Deaths => "once agents answer again",
    };
    let line = format!("{}. Resume {when}: `{}`", stop.note(), resume(dir));
    let mut shown = run.clone();
    shown.not_run.push(line.clone());
    crate::verify::stood(&mut shown);
    let verdict = report::verdict(&shown);
    let path = state::report_path(dir);
    std::fs::write(&path, report::markdown(&shown, &verdict))
        .map_err(|source| StepError::NoReport { path, source })?;
    let mut done = finished::step(dir, &shown, &verdict);
    if let Some(obj) = done.as_object_mut() {
        obj.insert("line".into(), json!(format!("{verdict} — {line}")));
        obj.insert("stopped".into(), json!(stop));
        obj.insert("resume".into(), json!(resume(dir)));
    }
    Ok(done)
}
