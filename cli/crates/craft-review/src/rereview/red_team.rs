//! The red team on a prior Critical or High finding its adjudicator called resolved, as the
//! adjudicate track of `lib/review-adjudicate-priors.mjs` sends it (`shouldRedTeam`,
//! `classifyRedTeam` in `lib/review-adjudicate.mjs`): an independent agent that never sees the
//! adjudicator's verdict attacks the fix under the invariant it named. A concrete attack reopens
//! the finding; a dead red team, or one claiming defeat with no attack, leaves it resolved on the
//! adjudicator's own attack pass, and says so.

use serde_json::Value;

use super::judge::field;
use super::{Chain, Fate};
use crate::absorbed::base_why;
use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::prompts::{self, PromptContext};
use crate::state::{Task, TaskKind, TaskState};

/// The answer a task gave, when it gave a valid one.
fn answered(t: &Task) -> Option<&Value> {
    t.answer.as_ref().filter(|_| t.state == TaskState::Answered)
}

/// Whether a severity is Critical or High, case and spacing aside (`isHighSeverity`).
fn high(severity: &str) -> bool {
    matches!(severity.trim().to_lowercase().as_str(), "critical" | "high")
}

/// One red team per Critical or High prior whose adjudicator among `tasks` answered a clean
/// `resolved` — no attack of its own. Built before the answers move the priors, so each names the
/// line and rationale its adjudicator was asked about.
///
/// # Errors
/// When the prompt cannot be rendered or the schema read.
pub fn tasks(
    ctx: &PromptContext,
    chain: &Chain,
    tasks: &[Task],
) -> Result<Vec<Task>, ContentError> {
    let mut out = Vec::new();
    for t in tasks {
        let TaskKind::Adjudicate { prior } = t.kind else {
            continue;
        };
        let (Some(p), Some(a)) = (chain.priors.get(prior), answered(t)) else {
            continue;
        };
        let clean =
            field(a, "status") == "resolved" && prompts::sanitize(field(a, "attack")).is_empty();
        if !clean || !high(&p.row.severity) {
            continue;
        }
        out.push(Task::new(
            format!("red-team-{prior}"),
            format!("redteam:{}:{}", p.row.file, p.row.line),
            prompts::red_team_prompt(ctx, &p.row, field(a, "invariant"))?,
            Model::Opus,
            content::schema("attack")?,
            TaskKind::RedTeam { prior },
        ));
    }
    Ok(out)
}

/// Takes the red teams' answers among `tasks` into the chain's priors: a concrete attack reopens
/// its prior still open. Returns the notes of what the red teams did.
pub fn take(chain: &mut Chain, tasks: &[Task]) -> Vec<String> {
    let mut notes = Vec::new();
    let [mut overturned, mut died, mut invalid] = [0; 3];
    for t in tasks {
        let TaskKind::RedTeam { prior } = t.kind else {
            continue;
        };
        let Some(p) = chain
            .priors
            .get_mut(prior)
            .filter(|p| p.fate == Fate::Resolved)
        else {
            continue;
        };
        let at = format!("{}:{}", p.row.file, p.row.line);
        let Some(a) = answered(t) else {
            died += 1;
            notes.push(format!("the red team for {at} died — \"resolved\" stands on the adjudicator's own attack pass only"));
            continue;
        };
        if a.get("defeated") != Some(&Value::Bool(true)) {
            continue;
        }
        let attack = prompts::sanitize(field(a, "attack"));
        if attack.is_empty() {
            invalid += 1;
            notes.push(format!("the red team for {at} claimed defeat with NO attack — invalid verdict discarded, keeping resolved"));
            continue;
        }
        overturned += 1;
        let attack = prompts::sanitize(&format!("(red-team) {attack}"));
        p.row.why = format!("{} — fix incomplete: {attack}", base_why(&p.row.why));
        p.fate = Fate::StillOpen;
    }
    let ran = tasks
        .iter()
        .filter(|t| matches!(t.kind, TaskKind::RedTeam { .. }))
        .count();
    if ran > 0 {
        notes.push(format!("red team: {ran} resolved Critical/High prior(s) attacked — {overturned} overturned (still open), {died} red team(s) died, {invalid} invalid"));
    }
    notes
}
