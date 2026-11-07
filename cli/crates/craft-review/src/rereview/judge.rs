//! The prior round's open findings adjudicated, as `adjudicateOne` in `lib/review-adjudicate.mjs`
//! judges each answer.

use serde_json::Value;

use super::{Chain, Fate, carry_check};
use crate::absorbed::base_why;
use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::coverage;
use crate::ledger::LedgerRow;
use crate::profile::Profile;
use crate::prompts::{self, PromptContext};
use crate::state::{Task, TaskKind, TaskState};

/// The skill whose rubric judges a finding in `file`: its profile's, the general rules otherwise.
fn rubric_for(file: &str, profiles: &[Profile]) -> String {
    coverage::assign(&[file.to_owned()], profiles)
        .first()
        .and_then(|(i, _)| profiles.get(*i))
        .map_or_else(|| "review-rules".into(), |p| p.rubric_skill.clone())
}

/// One carry-check per prior finding its author set aside, and one adjudicator per prior finding
/// still open and checked, on the lens model.
///
/// # Errors
/// When a prompt cannot be rendered or the schema read.
pub fn tasks(
    ctx: &PromptContext,
    chain: &Chain,
    profiles: &[Profile],
) -> Result<Vec<Task>, ContentError> {
    let mut out = carry_check::tasks(ctx, chain)?;
    for (i, p) in chain.priors.iter().enumerate() {
        if p.fate != Fate::Pending {
            continue;
        }
        let rubric = rubric_for(&p.row.file, profiles);
        out.push(Task::new(
            format!("adjudicate-{i}"),
            format!("adjudicate:{}:{}", p.row.file, p.row.line),
            prompts::adjudicate_prompt(ctx, &p.row, &rubric)?,
            Model::Opus,
            content::schema("adjudicate")?,
            TaskKind::Adjudicate { prior: i },
        ));
    }
    Ok(out)
}

pub(super) fn field<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// The fate of a prior from its adjudicator's answer, `None` when it gave none, and its rationale.
fn fate_of(row: &LedgerRow, answer: Option<&Value>) -> (Fate, String) {
    let base = base_why(&row.why);
    let Some(a) = answer else {
        let why =
            format!("{base} — still-open (adjudicator did not run; kept still-open by default)");
        return (Fate::StillOpen, why);
    };
    let attack = prompts::sanitize(field(a, "attack"));
    let note = prompts::sanitize(field(a, "note"));
    match field(a, "status") {
        "resolved" if attack.is_empty() => (Fate::Resolved, row.why.clone()),
        "cannot-tell" => (
            Fate::StillOpen,
            format!("{base} — UNVERIFIED (adjudicator could not tell): {note}"),
        ),
        "regressed" => {
            let what = if attack.is_empty() { note } else { attack };
            (
                Fate::Regressed,
                format!("{base} — REGRESSED after fix: {what}"),
            )
        }
        // still-open, a resolved that carries an attack, and any status the schema does not know.
        _ if attack.is_empty() => (Fate::StillOpen, row.why.clone()),
        _ => (
            Fate::StillOpen,
            format!("{base} — fix incomplete: {attack}"),
        ),
    }
}

/// Settles each prior carried as Known and deferred (`deferralHeld` in
/// `lib/review-adjudicate-priors.mjs`; realm @nick/craft, node #204) once the memory is recalled:
/// one whose question still `holds` stays deferred, out of the verdict; one a record releases counts
/// again, kept still open until the next round adjudicates it. A deferred prior whose code changed
/// since its question's commit was never carried: it is adjudicated and counted by its answer.
/// Returns the notes of the released.
pub fn hold_deferrals(chain: &mut Chain, holds: &dyn Fn(&LedgerRow) -> bool) -> Vec<String> {
    let mut notes = Vec::new();
    for p in chain
        .priors
        .iter_mut()
        .filter(|p| p.fate == Fate::Deferred && !holds(&p.row))
    {
        // Released by a record that answers its question, it counts again; no adjudicator was
        // asked for it beside the scouts, so it is kept still open and adjudicated next round.
        p.row.why = format!(
            "{} (its deferral was released by a record that answers its question; not adjudicated this round, kept still open)",
            base_why(&p.row.why)
        );
        p.row.disposition = "open".into();
        p.fate = Fate::StillOpen;
        notes.push(format!(
            "the deferral on {}:{} no longer holds — a record answers its question: kept still open, adjudicated next round",
            p.row.file, p.row.line
        ));
    }
    notes
}

/// Takes the adjudicators' answers among `tasks` into the chain's priors: each one's fate, its
/// re-located line and its rationale; a dead adjudicator keeps its prior still open. Returns the
/// notes of what could not be judged.
pub fn judge(chain: &mut Chain, tasks: &[Task]) -> Vec<String> {
    let mut notes = carry_check::judge(chain, tasks);
    for t in tasks {
        let TaskKind::Adjudicate { prior } = t.kind else {
            continue;
        };
        let Some(p) = chain.priors.get_mut(prior) else {
            continue;
        };
        let answer = t.answer.as_ref().filter(|_| t.state == TaskState::Answered);
        if answer.is_none() {
            notes.push(format!(
                "the adjudicator of {}:{} gave no valid answer ({}): the prior finding is kept still open",
                p.row.file,
                p.row.line,
                t.error.as_deref().unwrap_or("no answer")
            ));
        }
        let (fate, why) = fate_of(&p.row, answer);
        let line = answer
            .and_then(|a| a.get("currentLine"))
            .and_then(Value::as_i64)
            .filter(|l| *l > 0);
        if let Some(l) = line {
            p.row.line = l;
        }
        p.fate = fate;
        // `currentLine` 0 is "not found": such a prior keeps the old line, and with it the
        // file-and-rule key.
        p.located = line.is_some();
        p.row.why = why;
    }
    notes
}
