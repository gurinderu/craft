//! A run stopped before its end, as every kind of the step protocol stops (realm @nick/craft,
//! nodes #299, #300, #610): the host saw the account's usage limit (`--limit`), or — the review's
//! own cause — a dispatch round died whole. A stopped run is not done: its unanswered tasks are
//! held as they were first handed out, and the next submit without `--limit` hands them out again.

use craft_store::js::JsStr;
use serde::{Deserialize, Serialize};

use crate::kind::Kind;
use crate::task::{Task, TaskState};

/// How much of the host's limit text, or of a dead agent's last line, a stop keeps, as
/// `usageLimitText` cuts it.
pub const TEXT_MAX: usize = 200;
/// What a dead round most likely was, as the engines say it, when no dead agent said why.
const DEATHS_LIKELY: &str = "most likely the account's usage limit or an outage";

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

    /// When the run can go on, as its resume line says it.
    #[must_use]
    pub const fn when(&self) -> &'static str {
        match self.cause {
            Cause::Limit => "once the limit resets",
            Cause::Deaths => "once agents answer again",
        }
    }
}

/// The stop on the host's limit `text`, its whitespace folded and cut.
#[must_use]
pub fn limit(text: &str) -> Stop {
    let one = text.js_split_whitespace().collect::<Vec<_>>().join(" ");
    Stop {
        cause: Cause::Limit,
        text: one.chars().take(TEXT_MAX).collect(),
        told: false,
    }
}

/// The stop of a round that died whole, said as `text`.
#[must_use]
pub fn deaths(text: String) -> Stop {
    Stop {
        cause: Cause::Deaths,
        text,
        told: false,
    }
}

/// Holds every task not answered as it was first handed out, to be handed out again — but one
/// abandoned at its deadline, which stays failed: pending, its retries, error and refusal cleared.
/// Its counted refused file (`counted`) is kept, so one still in place is not read as a new answer
/// on the resume.
pub fn hold<K: Kind>(tasks: &mut [Task<K>]) {
    for t in tasks
        .iter_mut()
        .filter(|t| t.state != TaskState::Answered && !t.abandoned)
    {
        t.state = TaskState::Pending;
        t.retries = 0;
        t.error = None;
        t.refused = None;
    }
}

/// The command that resumes the run in `dir` of the kind `kind` (`review`, `triage`).
#[must_use]
pub fn resume(kind: &str, dir: &std::path::Path) -> String {
    let d = dir.display().to_string().replace('\'', r"'\''");
    format!("craft {kind} submit --run '{d}' --resume")
}

#[cfg(test)]
mod tests;
