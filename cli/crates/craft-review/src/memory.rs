//! What the review knows beyond the diff: the project's memory, as the review engine recalls and
//! applies it (realm @nick/craft, nodes #203, #218, #250). One read-only agent recalls, beside the
//! scouts, the active decisions, questions and project rules for the change's paths
//! ([`recall`]); the records the launcher passes (`priorDecisions`: rejections read from a PR's
//! threads, say) add to it ([`merge`]); once the findings are verified, a finding the project
//! already rejected or deferred is set aside under its own section, never dropped ([`apply`]), its
//! record's scope checked against the repository by git here, with no agent. The report names where
//! the records came from and what was not applied; the ledger carries what was set aside as the
//! author's word, so the next round carries it.

mod apply;
mod id;
mod matching;
mod merge;
#[cfg(test)]
mod parity;
mod recall;
mod record;
mod source;
#[cfg(test)]
mod tests;

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use record::{PriorDecision, RecordKind};
pub use source::MemorySource;

use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::git;
use crate::ledger::LedgerRow;
use crate::report::Tier;
use crate::state::{Task, TaskKind, TaskState};

/// A run's memory: the records it applies, what of them was refused, where they came from, and the
/// findings they set aside.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Memory {
    /// The launcher's own list as it was passed, kept until the recall merges it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub passed: Option<Value>,
    pub decisions: Vec<PriorDecision>,
    pub refused: Vec<String>,
    pub source: MemorySource,
    pub set_aside: Vec<Value>,
}

impl Memory {
    /// The memory of a run before its recall: the launcher's `passed` list read on its own.
    #[must_use]
    pub fn open(passed: Option<Value>) -> Self {
        let m = merge::launch(passed.as_ref());
        Self {
            passed,
            decisions: m.decisions,
            refused: m.refused,
            source: m.source,
            set_aside: Vec::new(),
        }
    }

    /// The memory of a run that recalls, or that recalls nothing itself: its launcher's records
    /// alone, said so.
    #[must_use]
    pub fn recalling(mut self, recall: bool) -> Self {
        if recall {
            return self;
        }
        self.source.why =
            "not recalled — the launcher asked for none (--no-recall): only its own records apply"
                .into();
        self
    }

    /// The recall agent's task over the change's `paths`.
    ///
    /// # Errors
    /// When its prompt or schema is missing.
    pub fn recall_task(repo: &str, paths: &[String], base: &str) -> Result<Task, ContentError> {
        let prompt = recall::prompt(paths, base)?;
        Ok(Task::new(
            "memory-recall".into(),
            "memory-recall".into(),
            format!("{}{prompt}", crate::prompts::repo_directive(repo)),
            Model::Sonnet,
            content::schema("memory-recall")?,
            TaskKind::Recall {
                cut: paths.len().saturating_sub(recall::RECALL_PATHS_MAX),
            },
        ))
    }

    /// Reads the recall's answer among `tasks`, if one was asked for, and merges the launcher's
    /// records into it. A recall that gave no answer applies the launcher's records alone.
    pub(crate) fn take_recall(&mut self, tasks: &[Task]) {
        let Some((task, cut)) = tasks.iter().find_map(|t| {
            if let TaskKind::Recall { cut } = t.kind {
                Some((t, cut))
            } else {
                None
            }
        }) else {
            return;
        };
        let answer = task
            .answer
            .as_ref()
            .filter(|_| task.state == TaskState::Answered);
        let m = merge::merge(recall::read(answer, cut), self.passed.as_ref());
        self.decisions = m.decisions;
        self.refused = m.refused;
        self.source = m.source;
    }

    /// Sets aside the findings of `settled` a record answers, in the repository at `repo`; what it
    /// did goes to `notes`.
    pub(crate) fn apply(&mut self, repo: &Path, settled: &mut Vec<Value>, notes: &mut Vec<String>) {
        if self.decisions.is_empty() || settled.is_empty() {
            return;
        }
        let (refuted, judged): (Vec<Value>, Vec<Value>) = settled
            .drain(..)
            .partition(|f| Tier::of(f) == Tier::Refuted);
        let check = |ds: &[&PriorDecision]| scope_check(repo, ds);
        let out = apply::apply(judged, &self.decisions, &check);
        *settled = out.kept;
        settled.extend(refuted);
        notes.extend(out.notes.iter().map(|n| format!("prior decisions: {n}")));
        self.refused.extend(out.refused);
        self.set_aside = out.set_aside;
    }

    /// The ledger rows of the findings set aside: the author's word, which the next round carries.
    #[must_use]
    pub fn ledger_rows(&self) -> Vec<LedgerRow> {
        self.set_aside
            .iter()
            .map(|f| {
                let question = f.get("priorKind").and_then(Value::as_str) == Some("question");
                LedgerRow {
                    disposition: if question { "deferred" } else { "rejected" }.into(),
                    tier: f
                        .get("priorTier")
                        .and_then(Value::as_str)
                        .unwrap_or("confirmed")
                        .into(),
                    ..LedgerRow::open(f)
                }
            })
            .collect()
    }

    /// The report's sections: what was set aside, where the records came from, what was refused.
    #[must_use]
    pub fn report(&self) -> String {
        format!(
            "{}\n\n## Memory\n- {}\n{}",
            apply::section(&self.set_aside),
            self.source.line(),
            apply::refused_section(&self.refused)
        )
    }
}

/// The scope check of `ds`, by git in `repo` (`scopeCheckScript`, run here rather than by an
/// agent): a record whose commit the repository lacks is missing; one whose scope `git diff
/// --quiet` shows untouched since its commit, the working tree included, is unchanged.
fn scope_check(repo: &Path, ds: &[&PriorDecision]) -> apply::Scope {
    let mut out = apply::Scope::default();
    for d in ds {
        if !git::has_commit(repo, &d.commit) {
            out.missing.insert(d.id.clone());
        } else if git::unchanged_since(repo, &d.commit, &d.scope) {
            out.unchanged.insert(d.id.clone());
        }
    }
    out
}
