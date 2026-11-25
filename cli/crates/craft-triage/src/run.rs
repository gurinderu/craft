//! The triage run as the binary drives it (realm @nick/craft, node #616): from its arguments and
//! the answers its agents gave so far, the phases `triage-findings.js` runs, in its order — the
//! gatherers, the recall, the memory's judges, the validators, the plan — each asking its agents
//! when its answers are not in, and once all are, the finished run: its plan and its record. The
//! run keeps no derived state: every step derives it again from the answers ([`Answers`]), so a
//! replay of the same answers, a parity case's say, gives the same run.

mod finish;
mod gather;
mod plan;
mod sift;
mod validate;

use craft_review::memory::{PriorDecision, Scope};
use craft_step::Model;
use craft_store::js::Js;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::TriageError;
use crate::kind::TriageKind;

pub use finish::Finished;

/// What a triage is run with, as `triage-findings.js` reads its arguments.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Args {
    /// The report file to gather from; '' when none.
    pub report: String,
    /// The PR number to gather from; '' when none.
    pub pr: String,
    /// The ref the findings were generated against; '' validates the checked-out tree.
    pub base: String,
    /// The commit the PR forks from, as given (`effectivePrBase` reads it).
    pub pr_base: String,
    /// The repository the findings are in, when it is not the session's own.
    pub repo: String,
    /// The prior ledger's rows, as given.
    pub prior_ledger: Vec<Value>,
    /// The launcher's records (`priorDecisions`), or why they could not be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prior_decisions: Option<Result<Value, String>>,
    /// The craft release that runs it, for its record.
    pub craft_version: String,
}

/// Where a run stands: the phase whose agents it waits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Gather,
    Recall,
    Match,
    Rules,
    Validate,
    Plan,
    Done,
}

/// What the run asks one agent.
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    pub kind: TriageKind,
    pub id: String,
    pub label: String,
    pub prompt: String,
    pub schema: Value,
    pub model: Model,
}

/// The answers the run's agents gave: `None` when the agent was not asked yet, `Some(None)` when
/// it was and gave none.
pub trait Answers {
    fn answer(&self, kind: &TriageKind) -> Option<Option<Js>>;
}

/// What the run does next: ask the agents of a phase, or end.
#[derive(Debug, Clone, PartialEq)]
pub enum Progress {
    Asks(Phase, Vec<Ask>),
    Done(Box<Finished>),
}

/// A phase's outcome: what it found, or the agents to ask first.
pub(crate) enum Ready<T> {
    Got(T),
    Ask(Phase, Vec<Ask>),
}

/// The value of a phase that is ready, else its asks returned from the run.
macro_rules! ready {
    ($e:expr) => {
        match $e {
            Ready::Got(v) => v,
            Ready::Ask(phase, asks) => return Ok(Progress::Asks(phase, asks)),
        }
    };
}

/// The run with `args` as far as `answers` carry it, `scope` observing the scopes of the records
/// the memory checks.
///
/// # Errors
/// When a prompt or schema cannot be rendered.
pub fn run(
    args: &Args,
    answers: &dyn Answers,
    scope: &dyn Fn(&[&PriorDecision]) -> Scope,
) -> Result<Progress, TriageError> {
    let gathered = ready!(gather::gather(args, answers)?);
    let sifted = ready!(sift::sift(args, answers, &gathered, scope)?);
    let validated = ready!(validate::validate(args, answers, &sifted)?);
    let plan = ready!(plan::plan(args, answers, &gathered, &sifted, &validated)?);
    Ok(Progress::Done(Box::new(finish::finish(
        args,
        &gathered,
        &sifted,
        &validated,
        plan.as_ref(),
    ))))
}

/// An agent's ask on the cheap model.
pub(crate) fn sonnet(
    kind: TriageKind,
    id: &str,
    label: &str,
    prompt: String,
    schema: Value,
) -> Ask {
    Ask {
        kind,
        id: id.into(),
        label: label.into(),
        prompt,
        schema,
        model: Model::Sonnet,
    }
}
