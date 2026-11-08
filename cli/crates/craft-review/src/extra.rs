//! The consumer repository's own reviewing agents run as extra lenses (realm @nick/craft, nodes
//! #295, #414, #264), as `lib/review-extra-lenses.mjs` and `lib/review-extra-lens-run.mjs` run them:
//! named by the caller, or — on a light pass with none named — discovered among the roles the
//! session's project declares under `.claude/agents`; each runs once beside the first lens round on
//! its own agent, reviews the whole change, and its findings join the pool after the rounds, under
//! the first profile's rubric. A named one that cannot run is a coverage gap; a discovered one is
//! said, never a gap (realm @nick/craft, node #178).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::prompts;
use crate::rounds::key;
use crate::state::{RunState, Task, TaskKind, TaskState};

mod discover;
mod frontmatter;
mod report;
mod request;
#[cfg(test)]
mod tests;

pub use discover::{DISCOVERY_SKIPPED, discover, may_edit, pick_reviewers};
pub use frontmatter::{Definition, parse_definition};
pub use report::section;
pub use request::{agent_type_form, request};

/// How the extra lenses were chosen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum How {
    #[default]
    Off,
    Named,
    Discovered,
}

/// An extra lens that did not run, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failed {
    pub agent: String,
    pub why: String,
}

/// Why a run ended before its lenses, as the extra lenses' account names it, and whether the diff
/// had anything for them to review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExitNote {
    pub reason: String,
    pub needed: bool,
}

/// A run's extra lenses.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extra {
    pub how: How,
    /// The agents to run: those named, or those discovery chose.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agents: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ran: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed: Vec<Failed>,
    /// What discovery read, when it chose none.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub discovery: String,
    /// The lenses were reached: dispatched beside the first round.
    #[serde(default)]
    pub reached: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<ExitNote>,
    /// Their findings, held until the lens rounds end.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub found: Vec<Value>,
}

/// Each extra lens's task beside the first round, told what the pool holds and the rule files of
/// the first profile's plan; marks the lenses reached.
///
/// # Errors
/// When a prompt cannot be rendered or the findings schema read.
pub(crate) fn tasks(run: &mut RunState) -> Result<Vec<Task>, ContentError> {
    if run.extra.reached || run.extra.how == How::Off {
        return Ok(Vec::new());
    }
    run.extra.reached = true;
    let prior = prompts::prior_found_summary(&run.rounds.pool);
    let rules = run
        .tracks
        .first()
        .and_then(|t| t.plan.as_ref())
        .map(|p| p.repo_rules.clone())
        .unwrap_or_default();
    let mut out = Vec::new();
    for (i, agent) in run.extra.agents.iter().enumerate() {
        let safe: String = agent
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let mut task = Task::new(
            format!("extra-{i}-{safe}"),
            format!("extra-lens:{agent}"),
            prompts::extra_lens_prompt(&run.context, agent, &prior, &rules)?,
            Model::Opus,
            content::schema("findings")?,
            TaskKind::Extra {
                agent: agent.clone(),
            },
        );
        task.consumer_agent = Some(agent.clone());
        out.push(task);
    }
    Ok(out)
}

/// Takes the extra lenses' answers among `tasks`: each finding held for the pool, under `first`,
/// the run's first profile, its `source` `extra:<agent>`; each lens with none named failed.
pub(crate) fn take(extra: &mut Extra, tasks: &[Task], first: &str) {
    for t in tasks {
        let TaskKind::Extra { agent } = &t.kind else {
            continue;
        };
        let answer = t.answer.as_ref().filter(|_| t.state == TaskState::Answered);
        let Some(found) = answer
            .and_then(|a| a.get("findings"))
            .and_then(Value::as_array)
        else {
            let why = if t.refused.is_some() {
                "answered off-schema (no findings array)"
            } else {
                "returned nothing (an unknown agent type on some runtimes, or a dead agent)"
            };
            extra.failed.push(Failed {
                agent: agent.clone(),
                why: why.into(),
            });
            continue;
        };
        extra.ran.push(agent.clone());
        for f in found {
            let mut f = f.as_object().cloned().unwrap_or_default();
            f.insert("source".into(), Value::String(format!("extra:{agent}")));
            f.insert("profile".into(), Value::String(first.to_owned()));
            f.insert("foundInRound".into(), Value::from(1));
            extra.found.push(Value::Object(f));
        }
    }
}

/// After the rounds: the held findings into the pool, each whose key it lacks; and each named lens
/// that did not run as a coverage gap.
pub(crate) fn join(run: &mut RunState) {
    for f in std::mem::take(&mut run.extra.found) {
        let k = key(&f);
        if !run.rounds.pool.iter().any(|g| key(g) == k) {
            run.rounds.pool.push(f);
        }
    }
    run.not_run.extend(gaps(&run.extra));
}

/// The not-run line of each named lens that did not run.
fn gaps(extra: &Extra) -> Vec<String> {
    if extra.how != How::Named {
        return Vec::new();
    }
    extra
        .failed
        .iter()
        .map(|x| {
            format!(
                "extra lens {} -- {}, so its review did not happen",
                x.agent, x.why
            )
        })
        .collect()
}

/// A run that ended before its lenses: the extra lenses did not run either. A named one is a gap
/// when the diff had something to review; a discovery that never ran is said in the report.
pub(crate) fn not_reached(run: &mut RunState) {
    if run.extra.reached || run.extra.how == How::Off || run.exit.is_none() {
        return;
    }
    run.extra.reached = true;
    let (reason, needed) = exit_reason(run);
    if run.extra.how == How::Named && needed {
        let why = format!("not run: {reason}");
        let named = run.extra.agents.iter().map(|a| Failed {
            agent: a.clone(),
            why: why.clone(),
        });
        run.extra.failed.extend(named.collect::<Vec<_>>());
    }
    run.extra.exit = Some(ExitNote {
        reason: reason.into(),
        needed,
    });
    run.not_run.extend(gaps(&run.extra));
}

/// Why the run ended before its lenses, and whether the diff carried anything to review.
fn exit_reason(run: &RunState) -> (&'static str, bool) {
    if run.gate.exit().is_some() {
        ("the mechanical gate is red", true)
    } else if run.diff.files.is_empty() {
        ("the diff is empty", false)
    } else if run
        .exit
        .as_ref()
        .is_some_and(|e| e.verdict.starts_with("Approve"))
    {
        ("nothing reviewable changed", false)
    } else {
        ("no language profile covers the diff", true)
    }
}
