//! The memory as a kind of run other than the review asks it (realm @nick/craft, node #616): over a
//! plain list of findings, with no chain of rounds, each agent it needs handed back as an [`Ask`]
//! the kind wraps in its own task, and each answer read back here. The marks and notes go to the
//! field the kind names: the review's are its findings' `why`, triage's their `memoryNote`.

use std::path::Path;

use serde_json::Value;

use super::apply::{self, Applied, Scope};
use super::rules::{self, Covered};
use super::{Memory, PriorDecision, RecordKind};
use crate::agent::Model;
use crate::content::ContentError;
use crate::state::{Task, TaskKind};

/// What the memory asks an agent, in no kind's task: its id and label, its prompt with no
/// repository directive (the kind adds its own) and its answer's schema. Every memory agent runs
/// on the cheap model.
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    pub id: String,
    pub label: String,
    pub prompt: String,
    pub schema: Value,
}

impl Ask {
    /// The review's task of `kind` asking it.
    pub(crate) fn task(self, kind: TaskKind) -> Task {
        Task::new(
            self.id,
            self.label,
            self.prompt,
            Model::Sonnet,
            self.schema,
            kind,
        )
    }
}

/// The scope check by git in `repo`, as the review runs it: a record whose commit the repository
/// lacks is missing; one whose scope `git diff --quiet` shows untouched since its commit, the
/// working tree included, is unchanged.
pub fn git_scope(repo: &Path) -> impl Fn(&[&PriorDecision]) -> Scope + '_ {
    move |ds| super::priors::scope_check(repo, ds)
}

impl Memory {
    /// The match judge's ask over `findings`, `None` when no pair needs it. Each record that could
    /// set one aside has its scope observed by `check` first, so the one ask also covers the
    /// outright matches it raises again; what it observed and the pairs asked are kept for
    /// [`Memory::decide`].
    ///
    /// # Errors
    /// When its template or schema is missing.
    pub fn match_ask(
        &mut self,
        findings: &[Value],
        focus: &[String],
        check: &dyn Fn(&[&PriorDecision]) -> Scope,
    ) -> Result<Option<Ask>, ContentError> {
        let prepared = apply::prepare(findings, &self.decisions, check, focus);
        self.asked.matched = Some(prepared.to_keep());
        prepared.ask(findings)
    }

    /// Splits `findings` by the decisions, `answer` the match judge's when it was asked, read
    /// against what [`Memory::match_ask`] kept (with nothing kept, `check` observes the scopes);
    /// each mark and note appended to the field `note`.
    pub fn decide(
        &mut self,
        findings: Vec<Value>,
        (answer, focus): (Option<&Value>, &[String]),
        check: &dyn Fn(&[&PriorDecision]) -> Scope,
        note: &str,
    ) -> Applied {
        let prepared = match self.asked.matched.take() {
            Some(asked) => apply::prepare_asked(&findings, &self.decisions, &asked, focus),
            None => apply::prepare(&findings, &self.decisions, check, focus),
        };
        apply::apply(findings, &prepared, answer, note)
    }

    /// The rule judge's asks over `findings`, none when no finding sits in a rule's scope; the
    /// pairs asked are kept for [`Memory::rule`].
    ///
    /// # Errors
    /// When its template or schema is missing.
    pub fn rule_asks(
        &mut self,
        findings: &[Value],
        focus: &[String],
    ) -> Result<Vec<Ask>, ContentError> {
        let pairs = rules::Pairs::new(findings, &self.decisions, focus);
        self.asked.ruled = Some(pairs.pairs().to_vec());
        pairs.asks(findings)
    }

    /// Covers by the project rules what of `findings` they cover, `answers` the rule judges' in
    /// their asks' order, read against the pairs [`Memory::rule_asks`] kept; each mark and note
    /// appended to the field `note`. With no rule given, every finding is kept and nothing said.
    pub fn rule(
        &mut self,
        findings: Vec<Value>,
        (answers, focus): (&[Option<Value>], &[String]),
        note: &str,
    ) -> Covered {
        let kept = self.asked.ruled.take();
        if !self.decisions.iter().any(|d| d.kind == RecordKind::Rule) {
            return Covered {
                kept: findings,
                ..Covered::default()
            };
        }
        let mut pairs = rules::Pairs::new(&findings, &self.decisions, focus);
        if let Some(asked) = kept {
            pairs.asked(asked);
        }
        rules::apply(findings, &pairs, answers, note)
    }
}

mod recall;
#[cfg(test)]
mod tests;

pub use recall::RecallCut;
