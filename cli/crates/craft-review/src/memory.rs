//! What the review knows beyond the diff: the project's memory, as the review engine recalls and
//! applies it (realm @nick/craft, nodes #203, #218, #250). One read-only agent recalls, beside the
//! scouts, the active decisions, questions and project rules for the change's paths
//! ([`recall`]); the records the launcher passes (`priorDecisions`: rejections read from a PR's
//! threads, say) add to it ([`merge`]); once the findings are verified, a finding the project
//! already rejected or deferred is set aside under its own section, never dropped ([`apply`]), its
//! record's scope checked against the repository by git here, with no agent, and a near miss
//! decided by the match judge ([`judge`]); then a finding a project rule covers is set aside under
//! its own, decided by the rule judge ([`rules`]). The report names where the records came from and
//! what was not applied; the ledger carries what was set aside as the author's word, so the next
//! round carries it.

mod apply;
mod asked;
mod id;
mod judge;
mod matching;
mod merge;
mod oppose;
#[cfg(test)]
mod parity;
mod priors;
mod recall;
mod record;
mod rules;
mod source;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use asked::{Asked, MatchAsked};
pub use record::{PriorDecision, RecordKind};
pub use source::MemorySource;

use crate::agent::Model;
use crate::content::{self, ContentError};
use crate::ledger::LedgerRow;
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
    /// The project rules' warnings: a Critical finding raised under a rule, a finding left in the
    /// verdict for want of the rule judge's verdict.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rule_notices: Vec<String>,
    /// Why the launcher's list could not be read at all, when it could not: refused, the run goes on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unread: Option<String>,
    /// What its judges were asked when their tasks were handed out, read back with their answers.
    #[serde(skip_serializing_if = "Asked::is_empty")]
    pub asked: Asked,
}

impl Memory {
    /// The memory of a run before its recall: the launcher's `passed` list read on its own; a list
    /// that could not be read (`Err`) applies nothing and is named.
    #[must_use]
    pub fn open(passed: Option<Result<Value, String>>) -> Self {
        let (passed, unread) = match passed {
            Some(Ok(v)) => (Some(v), None),
            Some(Err(why)) => (
                None,
                Some(format!(
                    "priorDecisions could not be read ({why}) — no decision applied"
                )),
            ),
            None => (None, None),
        };
        let m = merge::launch(passed.as_ref());
        let mut out = Self {
            passed,
            decisions: m.decisions,
            refused: Vec::new(),
            source: m.source,
            set_aside: Vec::new(),
            rule_notices: Vec::new(),
            unread,
            asked: Asked::default(),
        };
        out.set_refused(m.refused);
        out
    }

    /// The refusals, the unreadable launcher list named first.
    fn set_refused(&mut self, refused: Vec<String>) {
        self.refused = self.unread.iter().cloned().chain(refused).collect();
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
        self.set_refused(m.refused);
        self.source = m.source;
    }

    /// The ledger rows of the findings set aside: the author's word, which the next round carries.
    /// One a project rule covered is `covered`, not a dismissal: the next round adjudicates it like
    /// an open prior and applies the rules afresh (`priorDisposition`).
    #[must_use]
    pub fn ledger_rows(&self) -> Vec<LedgerRow> {
        self.set_aside
            .iter()
            .map(|f| {
                let disposition = match f.get("priorKind").and_then(Value::as_str) {
                    Some("question") => "deferred",
                    Some("rule") => "covered",
                    _ => "rejected",
                };
                LedgerRow {
                    disposition: disposition.into(),
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

    /// The report's sections: what was set aside this round and the `carried` deferred priors, what
    /// the rules covered, which of the verdict's `findings` go against a record, where the records
    /// came from, what was refused.
    #[must_use]
    pub fn report(&self, carried: &[Value], findings: &[Value]) -> String {
        let listed: Vec<Value> = self.set_aside.iter().chain(carried).cloned().collect();
        format!(
            "{}{}{}\n\n## Memory\n- {}\n{}",
            apply::section(&listed),
            rules::section(&self.set_aside, &self.rule_notices),
            judge::contradiction_section(findings),
            self.source.line(),
            apply::refused_section(&self.refused)
        )
    }
}
