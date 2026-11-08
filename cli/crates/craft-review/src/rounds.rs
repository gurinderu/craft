//! The lens rounds (`lensRoundsPhase` in `lib/review-lens-rounds.mjs`): every planned lens over
//! its profile's part of the diff, round after round, each told what the pool already holds, until
//! a round adds nothing new to its profile or the profile's plan's rounds are spent (loop until
//! dry). The profiles of a run share each round and the pool. A finding is new when no pooled
//! finding has its key (file, line and title); a lens dispatch that never returns is a hole the
//! verdict reads as INCOMPLETE.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::harm::raise::{claim_count, group_claims};
use crate::plan::Plan;
use crate::profile::Profile;
use crate::prompts::{self, LensIn, PromptContext};
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
    /// Every finding found so far, each once, its `source` the lens dispatched, its `profile` that
    /// lens's profile and its `foundInRound` the round that first found it.
    pub pool: Vec<Value>,
    pub yields: Vec<RoundYield>,
    /// The lenses dispatched, and those that answered at least once, each as `profile:lens`.
    pub expected: Vec<String>,
    pub returned: Vec<String>,
    /// Why each lens's last dispatch gave no answer, by `profile:lens`.
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

/// A lens as the rounds key it: its profile and its id.
fn lens_key(profile: &str, lens: &str) -> String {
    format!("{profile}:{lens}")
}

/// One task per planned lens of `profile` for `round`, over the profile's part `files`, each told
/// what the pool holds and run on the profile's lens agent; a metrics-or-nothing lens in the first round only.
///
/// # Errors
/// When a prompt cannot be rendered or the findings schema read.
pub fn tasks(
    ctx: &PromptContext,
    profile: &Profile,
    plan: &Plan,
    files: &[String],
    rounds: &Rounds,
) -> Result<Vec<Task>, ContentError> {
    let prior = prompts::prior_found_summary(&rounds.pool);
    let round = rounds.round;
    let pathspec = profile.pathspec(files);
    plan.lenses
        .iter()
        // A metrics lens reads numbers another round would not change: it runs in the first only.
        .filter(|l| round <= 1 || !profile.lens(l).is_some_and(|x| x.metrics))
        .map(|lens| {
            let spec = profile.lens(lens);
            let model = spec.map_or(Model::Opus, |l| l.model);
            // A metrics-or-nothing lens's findings carry the numbers they rest on.
            let schema = if spec.is_some_and(|l| l.metrics) {
                crate::complexity::findings_schema()?
            } else {
                content::schema("findings")?
            };
            let at = LensIn {
                profile,
                lens,
                plan,
                pathspec: &pathspec,
                prior: &prior,
            };
            let mut task = Task::new(
                format!("lens-{}-{lens}-r{round}", profile.id),
                format!("lens:{}:{lens} r{round}", profile.id),
                prompts::lens_prompt(ctx, &at)?,
                model,
                schema,
                TaskKind::Lens {
                    profile: profile.id.clone(),
                    lens: lens.clone(),
                    round,
                },
            );
            // Only the lenses run on the profile's agent, as the engine dispatches them
            // (lib/review-lens-dispatch.mjs); the scout, the dedup and the verifiers keep the default.
            task.agent_type = profile.lens_agent;
            Ok(task)
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

/// One lens finding as the pool keeps it: its lens as `source`, its profile, its first round.
fn pooled(found: &Value, profile: &str, lens: &str, round: u32) -> Value {
    let mut f: Map<String, Value> = found.as_object().cloned().unwrap_or_default();
    f.insert("source".into(), Value::String(lens.to_owned()));
    f.insert("profile".into(), Value::String(profile.to_owned()));
    f.insert("foundInRound".into(), Value::from(round));
    Value::Object(f)
}

impl Rounds {
    /// Takes the answers of a round's lens tasks into the pool; returns how many new findings
    /// each profile that dispatched a lens added (none: that profile's loop is dry).
    pub fn absorb(&mut self, tasks: &[Task]) -> BTreeMap<String, usize> {
        let mut fresh: Vec<Value> = Vec::new();
        let mut added: BTreeMap<String, usize> = BTreeMap::new();
        let mut returned = 0;
        for t in tasks {
            let TaskKind::Lens {
                profile,
                lens,
                round,
            } = &t.kind
            else {
                continue;
            };
            added.entry(profile.clone()).or_insert(0);
            let Some(answer) = self.answered(t, &lens_key(profile, lens)) else {
                continue;
            };
            returned += 1;
            let found = answer.get("findings").and_then(Value::as_array);
            for f in found.into_iter().flatten() {
                let f = pooled(f, profile, lens, *round);
                let at = key(&f);
                match self
                    .pool
                    .iter_mut()
                    .chain(fresh.iter_mut())
                    .find(|g| key(g) == at)
                {
                    Some(g) => note_exact_copy(g, &f),
                    None => {
                        fresh.push(f);
                        *added.entry(profile.clone()).or_insert(0) += 1;
                    }
                }
            }
        }
        self.yields.push(RoundYield {
            round: self.round,
            // The lens dispatches only: an extra lens beside the round is the consumer's agent.
            agents: tasks
                .iter()
                .filter(|t| matches!(t.kind, TaskKind::Lens { .. }))
                .count(),
            returned,
            new_findings: fresh.len(),
        });
        self.pool.extend(fresh);
        added
    }

    /// Records the dispatch of the lens keyed `k` and whether it answered; its answer if it did.
    fn answered<'t>(&mut self, t: &'t Task, k: &str) -> Option<&'t Value> {
        if !self.expected.iter().any(|e| e == k) {
            self.expected.push(k.to_owned());
        }
        let Some(answer) = t.answer.as_ref().filter(|_| t.state == TaskState::Answered) else {
            let why = t
                .error
                .clone()
                .unwrap_or_else(|| "returned no result (skipped or died without an error)".into());
            self.failures.insert(k.to_owned(), why);
            return None;
        };
        if !self.returned.iter().any(|r| r == k) {
            self.returned.push(k.to_owned());
        }
        Some(answer)
    }

    /// The lenses of `profile` that never answered in any round, each with why.
    #[must_use]
    pub fn holes(&self, profile: &str) -> Vec<String> {
        let prefix = lens_key(profile, "");
        self.expected
            .iter()
            .filter(|k| !self.returned.contains(k))
            .filter_map(|k| {
                let lens = k.strip_prefix(&prefix)?;
                let why = self.failures.get(k).map_or(
                    "returned no result (skipped or died without an error)",
                    String::as_str,
                );
                Some(format!("{lens}: {why}"))
            })
            .collect()
    }

    /// The lenses of `profile`'s plan that answered.
    #[must_use]
    pub fn ran(&self, profile: &str, plan: &Plan) -> Vec<String> {
        plan.lenses
            .iter()
            .filter(|l| self.returned.contains(&lens_key(profile, l)))
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests;
