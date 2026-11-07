//! The carry-check of a prior finding its author set aside (`rejected`, `justified`), as the
//! engine's adjudicate track runs it (`applyCarry` in `lib/review-adjudicate-priors.mjs`): one
//! agent decides only whether the code around it changed since the prior round's head. Changed, the
//! author's word no longer covers it and it is reopened — still open, counted by its severity, and
//! adjudicated by the next round. Unchanged, it has had its one confirmation and retires, leaving a
//! `dismissed` tombstone. No answer, it stays carried and is asked again next round.

use serde_json::Value;

use super::{Chain, Fate};
use crate::absorbed::base_why;
use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::prompts::{self, PromptContext};
use crate::state::{Task, TaskKind, TaskState};

/// One carry-check per prior its author set aside, on the engine's cull model.
///
/// # Errors
/// When a prompt cannot be rendered or the schema read.
pub(super) fn tasks(ctx: &PromptContext, chain: &Chain) -> Result<Vec<Task>, ContentError> {
    let Some(prior) = &chain.prior else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (i, p) in chain.priors.iter().enumerate() {
        if p.fate != Fate::Carried {
            continue;
        }
        out.push(Task::new(
            format!("carry-{i}"),
            format!("carry:{}:{}", p.row.file, p.row.line),
            prompts::carry_prompt(ctx, &p.row, &prior.head)?,
            Model::Sonnet,
            content::schema("changed")?,
            TaskKind::CarryCheck { prior: i },
        ));
    }
    Ok(out)
}

/// Takes the carry-checks' answers among `tasks` into the chain's priors. Returns the notes of the
/// checks that gave no answer.
pub(super) fn judge(chain: &mut Chain, tasks: &[Task]) -> Vec<String> {
    let mut notes = Vec::new();
    for t in tasks {
        let TaskKind::CarryCheck { prior } = t.kind else {
            continue;
        };
        let Some(p) = chain.priors.get_mut(prior) else {
            continue;
        };
        let answer = t.answer.as_ref().filter(|_| t.state == TaskState::Answered);
        match answer.and_then(|a| a.get("changed")).and_then(Value::as_bool) {
            None => notes.push(format!(
                "the carry-check of {}:{} gave no valid answer ({}): the finding its author set aside stays carried and is checked again next round",
                p.row.file,
                p.row.line,
                t.error.as_deref().unwrap_or("no answer")
            )),
            Some(true) => {
                p.row.why = format!(
                    "{} (reopened: dismissed as {}, but the code around it changed — re-verify the justification)",
                    base_why(&p.row.why),
                    p.row.disposition
                );
                p.row.disposition = "open".into();
                p.fate = Fate::StillOpen;
            }
            Some(false) => p.fate = Fate::Retired,
        }
    }
    notes
}
