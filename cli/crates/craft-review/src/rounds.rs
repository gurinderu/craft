//! The lens rounds (`lensRoundsPhase` in `lib/review-lens-rounds.mjs`): every planned lens over
//! the whole diff, round after round, each told what the pool already holds, until a round adds
//! nothing new or the plan's rounds are spent (loop until dry). A finding is new when no pooled
//! finding has its key (file, line and title); a lens dispatch that never returns is a hole the
//! verdict reads as INCOMPLETE.

use std::collections::BTreeMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::content;
use crate::harm::raise::{claim_count, group_claims};
use crate::plan::Plan;
use crate::profile::Profile;
use crate::prompts::{self, PromptContext};
use crate::state::{Task, TaskKind, TaskState};

/// What one round dispatched and what it added, as `lensRounds` records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundYield {
    pub round: u32,
    pub agents: usize,
    pub returned: usize,
    pub new_findings: usize,
}

/// The pool the rounds fill and the ledger of their dispatches.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rounds {
    /// The round under way, 0 before the first.
    pub round: u32,
    /// Every finding found so far, each once, its `source` the lens dispatched and its
    /// `foundInRound` the round that first found it.
    pub pool: Vec<Value>,
    pub yields: Vec<RoundYield>,
    /// The lenses dispatched, and those that answered at least once.
    pub expected: Vec<String>,
    pub returned: Vec<String>,
    /// Why each lens's last dispatch gave no answer.
    pub failures: BTreeMap<String, String>,
}

/// The exact key of a finding: its file and title folded, and its line, as `key` in
/// `lib/review-run.mjs`.
#[must_use]
pub fn key(f: &Value) -> String {
    let s = |k: &str| {
        f.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
    };
    let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
    let title = s("title").split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}:{line}:{title}", s("file"))
}

/// One task per planned lens for `round`, each told what the pool holds.
///
/// # Errors
/// When a prompt cannot be rendered or the findings schema read.
pub fn tasks(
    ctx: &PromptContext,
    profile: &Profile,
    plan: &Plan,
    rounds: &Rounds,
) -> Result<Vec<Task>> {
    let prior = prompts::prior_found_summary(&rounds.pool);
    let round = rounds.round;
    plan.lenses
        .iter()
        .map(|lens| {
            let model = profile.lens(lens).map_or("opus", |l| l.model.as_str());
            Ok(Task::new(
                format!("lens-{lens}-r{round}"),
                format!("lens:{}:{lens} r{round}", profile.id),
                prompts::lens_prompt(ctx, profile, lens, plan, &prior)?,
                model,
                content::schema("findings")?,
                TaskKind::Lens {
                    lens: lens.clone(),
                    round,
                },
            ))
        })
        .collect()
}

/// Records on `kept` that another lens filed the very same finding, as `noteExactCopy`.
fn note_exact_copy(kept: &mut Value, copy: &Value) {
    let src = |v: &Value| v.get("source").and_then(Value::as_str).map(str::to_owned);
    let Some(theirs) = src(copy).filter(|s| !s.is_empty()) else {
        return;
    };
    if src(kept).as_deref() == Some(theirs.as_str()) {
        return;
    }
    let mut had: Vec<Value> = match kept.get("sources").and_then(Value::as_array) {
        Some(a) => a.clone(),
        None => vec![kept.get("source").cloned().unwrap_or(Value::Null)],
    };
    let claims = group_claims([&*kept, copy]);
    let more = claims.len() > claim_count(kept);
    let Some(obj) = kept.as_object_mut() else {
        return;
    };
    if !had.contains(&Value::String(theirs.clone())) {
        had.push(Value::String(theirs));
        obj.insert("sources".into(), Value::Array(had));
    }
    if more {
        obj.insert("harmClaims".into(), Value::Array(claims));
    }
}

impl Rounds {
    /// Takes the answers of a round's lens tasks into the pool; true when it added nothing new
    /// (the loop is dry).
    pub fn absorb(&mut self, tasks: &[Task]) -> bool {
        let mut fresh: Vec<Value> = Vec::new();
        let mut returned = 0;
        for t in tasks {
            let TaskKind::Lens { lens, round } = &t.kind else {
                continue;
            };
            if !self.expected.contains(lens) {
                self.expected.push(lens.clone());
            }
            let answer = t.answer.as_ref().filter(|_| t.state == TaskState::Answered);
            let Some(answer) = answer else {
                let why = t.error.clone().unwrap_or_else(|| {
                    "returned no result (skipped or died without an error)".into()
                });
                self.failures.insert(lens.clone(), why);
                continue;
            };
            returned += 1;
            if !self.returned.contains(lens) {
                self.returned.push(lens.clone());
            }
            let found = answer.get("findings").and_then(Value::as_array);
            for f0 in found.into_iter().flatten() {
                let mut f: Map<String, Value> = f0.as_object().cloned().unwrap_or_default();
                f.insert("source".into(), Value::String(lens.clone()));
                f.insert("foundInRound".into(), Value::from(*round));
                let f = Value::Object(f);
                let k = key(&f);
                let kept = self
                    .pool
                    .iter_mut()
                    .chain(fresh.iter_mut())
                    .find(|g| key(g) == k);
                match kept {
                    Some(g) => note_exact_copy(g, &f),
                    None => fresh.push(f),
                }
            }
        }
        let new = fresh.len();
        self.pool.extend(fresh);
        self.yields.push(RoundYield {
            round: self.round,
            agents: tasks.len(),
            returned,
            new_findings: new,
        });
        new == 0
    }

    /// The planned lenses that never answered in any round, each with why.
    #[must_use]
    pub fn holes(&self) -> Vec<String> {
        self.expected
            .iter()
            .filter(|l| !self.returned.contains(l))
            .map(|l| {
                let why = self.failures.get(l).map_or(
                    "returned no result (skipped or died without an error)",
                    String::as_str,
                );
                format!("{l}: {why}")
            })
            .collect()
    }

    /// The planned lenses that answered.
    #[must_use]
    pub fn ran(&self, plan: &Plan) -> Vec<String> {
        plan.lenses
            .iter()
            .filter(|l| self.returned.contains(l))
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests;
