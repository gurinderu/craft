//! A round's tasks as requests to the host, before any runs (realm @nick/craft, nodes #453, #496):
//! each task's request, a stale answer removed first; a task whose request cannot be made left
//! unanswered; and what the round ran weaker than asked — an agent's body not found, or an opencode
//! agent missing whose task ran on `review-task`.

use std::collections::BTreeMap;

use craft_agent::AgentRequest;

use super::HostKind;
use super::opencode::{TASK_AGENT, placement};
use super::outcome::Outcome;
use super::round::RoundCtx;
use super::task::{Task, rubric_of};

/// The requests a round runs, and what was settled before any ran.
#[derive(Default)]
pub(crate) struct Prepared {
    pub(crate) requests: Vec<AgentRequest>,
    /// The task each request is, by index.
    pub(crate) ran: Vec<usize>,
    pub(crate) outcomes: BTreeMap<usize, Outcome>,
    /// The agents whose body was not found, and how many tasks named each.
    missing: BTreeMap<String, u64>,
    /// The agents the host lacks whose tasks ran on another, and how many.
    moved: BTreeMap<String, u64>,
}

/// Each task as its request, a stale answer removed first.
pub(crate) fn prepare(tasks: &[Task], ctx: &RoundCtx<'_>) -> Prepared {
    let mut p = Prepared::default();
    for (i, task) in tasks.iter().enumerate() {
        // A stale answer from an earlier attempt is never read as this one's.
        let _gone = std::fs::remove_file(&task.answer_file);
        let rubric = rubric_of(task, ctx.root, ctx.repo);
        if !rubric.missing().is_empty() {
            *p.missing.entry(rubric.missing().to_owned()).or_default() += 1;
        }
        if ctx.host.kind == HostKind::OpenCode
            && let Some(agent) = placement(task, ctx.host.agents.as_deref()).degraded
        {
            *p.moved.entry(agent).or_default() += 1;
        }
        match ctx.host.request(task, &rubric.body, (ctx.root, ctx.repo)) {
            Ok(r) => {
                p.requests.push(r);
                p.ran.push(i);
            }
            Err(why) => {
                p.outcomes
                    .insert(i, Outcome::Unanswered { why, said: None });
            }
        }
    }
    p
}

impl Prepared {
    /// The degraded notes of round `round`.
    pub(crate) fn notes(&self, round: usize, host: &str) -> Vec<String> {
        let missing = self.missing.iter().map(|(agent, n)| format!("round {round}: {n} task(s) named `{agent}`, whose prompt body the {host} driver did not find, and ran on the bare task prompt — this run is weaker than a normal one, not broken."));
        let moved = self.moved.iter().map(|(agent, n)| format!("round {round}: {n} task(s) named `{agent}`, an agent this {host} does not have, and ran on `{TASK_AGENT}` with its prompt body."));
        missing.chain(moved).collect()
    }
}
