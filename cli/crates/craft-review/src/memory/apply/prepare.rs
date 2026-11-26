//! A run's records made ready for the match judge (`applyPriorDecisions` up to its judge call):
//! those that apply, their scopes observed by git, each finding's candidates and the pairs the
//! judge is asked about.

use std::collections::BTreeSet;

use serde_json::Value;

use super::super::judge::{self, Judge};
use super::super::matching::{self, Plan};
use super::super::{MatchAsked, PriorDecision, RecordKind};
use super::Scope;
use super::judged::Asked;
use super::mark::reraise_reason;

/// Whether a record is matched against findings: every decision, a question only when it records
/// a deferral (`matchesFindings`); any other question is context.
fn matches_findings(d: &PriorDecision) -> bool {
    d.kind != RecordKind::Question || d.deferred
}

/// Every id a record is known by: its own and the store's.
fn aliases(d: &PriorDecision) -> impl Iterator<Item = &String> {
    std::iter::once(&d.id).chain(&d.stores)
}

/// The records a finding is matched against, and the notes on those that are not.
fn applicable(records: &[PriorDecision], notes: &mut Vec<String>) -> Vec<PriorDecision> {
    let given: Vec<&PriorDecision> = records
        .iter()
        .filter(|d| d.kind != RecordKind::Rule)
        .collect();
    let context = given.iter().filter(|d| !matches_findings(d)).count();
    if context > 0 {
        notes.push(format!(
            "{context} open question(s) record no deferral — context only, set nothing aside"
        ));
    }
    // A record another given record supersedes or answers no longer applies.
    let replaced: BTreeSet<&String> = given.iter().flat_map(|d| &d.supersedes).collect();
    let is_replaced = |d: &PriorDecision| aliases(d).any(|id| replaced.contains(id));
    let superseded: Vec<&str> = given
        .iter()
        .filter(|d| matches_findings(d) && is_replaced(d))
        .map(|d| d.id.as_str())
        .collect();
    if !superseded.is_empty() {
        notes.push(format!(
            "{} record(s) superseded by another given record — not applied: {}",
            superseded.len(),
            superseded.join(", ")
        ));
    }
    given
        .into_iter()
        .filter(|d| matches_findings(d) && !is_replaced(d))
        .cloned()
        .collect()
}

/// The records whose scope is checked: every one that could answer a finding a record may set
/// aside and that names a commit, a pull request or a date (realm @nick/craft, nodes #676, #682),
/// each once.
fn to_check<'a>(
    findings: &[Value],
    ds: &'a [PriorDecision],
    plans: &[Plan],
) -> Vec<&'a PriorDecision> {
    let mut at: Vec<usize> = Vec::new();
    for (f, p) in findings.iter().zip(plans) {
        for i in p
            .disputed
            .iter()
            .copied()
            .chain(p.sure.as_ref().map(|m| m.at))
        {
            let settable =
                |d: &PriorDecision| d.anchor().is_some() && !matching::reraised_by_rank(f, d);
            if ds.get(i).is_some_and(settable) && !at.contains(&i) {
                at.push(i);
            }
        }
    }
    let mut out: Vec<&PriorDecision> = Vec::new();
    for i in at {
        if let Some(d) = ds.get(i) {
            out.push(d);
        }
    }
    out
}

/// A run's records made ready for the judge: those applied, their scopes observed, each finding's
/// candidates and the pairs the judge is asked about.
#[derive(Debug, Clone, Default)]
pub(in crate::memory) struct Prepared {
    pub(super) ds: Vec<PriorDecision>,
    pub(super) scope: Scope,
    pub(super) plans: Vec<Plan>,
    pub(super) asked: Asked,
    pub(super) notes: Vec<String>,
}

/// Readies `records` for `findings` (none refuted), the judge's pairs ranked by the reviewed
/// `focus` paths past its bound, `check` observing the scopes of the records it
/// is handed (never none). The scope check runs first, so the one judge call is also asked about
/// the outright matches it raises again.
pub(in crate::memory) fn prepare(
    findings: &[Value],
    records: &[PriorDecision],
    check: &dyn Fn(&[&PriorDecision]) -> Scope,
    focus: &[String],
) -> Prepared {
    let mut notes = Vec::new();
    let ds = applicable(records, &mut notes);
    if ds.is_empty() {
        return Prepared {
            notes,
            ..Prepared::default()
        };
    }
    let order = matching::tried_order(&ds);
    let plans: Vec<Plan> = findings
        .iter()
        .map(|f| matching::plan(f, &ds, &order))
        .collect();
    let checked = to_check(findings, &ds, &plans);
    let mut scope = if checked.is_empty() {
        Scope::default()
    } else {
        check(&checked)
    };
    let was_checked = |id: &String| checked.iter().any(|d| &d.id == id);
    scope.missing.retain(was_checked);
    scope.why_missing.retain(|id, _| was_checked(id));
    scope.merged.retain(|id, _| was_checked(id));
    scope.between.retain(was_checked);
    let reraised = |fi: usize, di: usize| match (findings.get(fi), ds.get(di)) {
        (Some(f), Some(d)) => !reraise_reason(f, d, &scope).is_empty(),
        _ => false,
    };
    let asked = Asked::new(findings, &ds, &plans, &reraised, focus);
    Prepared {
        ds,
        scope,
        plans,
        asked,
        notes,
    }
}

/// Readies `records` for `findings` as they were readied when the judge was asked (`saved`): the
/// scopes git observed then, and the pairs asked then, so the answer is read against them.
pub(in crate::memory) fn prepare_asked(
    findings: &[Value],
    records: &[PriorDecision],
    saved: &MatchAsked,
    focus: &[String],
) -> Prepared {
    let seen = Scope {
        unchanged: saved.unchanged.clone(),
        missing: saved.missing.clone(),
        why_missing: saved.why_missing.clone(),
        merged: saved.merged.clone(),
        between: saved.between.clone(),
    };
    let mut p = prepare(findings, records, &|_| seen.clone(), focus);
    p.asked.pairs.clone_from(&saved.pairs);
    p
}

impl Prepared {
    /// What the judge is asked, to keep until it answers.
    pub(in crate::memory) fn to_keep(&self) -> MatchAsked {
        MatchAsked {
            unchanged: self.scope.unchanged.clone(),
            missing: self.scope.missing.clone(),
            why_missing: self.scope.why_missing.clone(),
            merged: self.scope.merged.clone(),
            between: self.scope.between.clone(),
            pairs: self.asked.pairs.clone(),
        }
    }

    /// The match judge's task over the asked pairs, `None` when there is none to ask.
    ///
    /// # Errors
    /// When its template or schema is missing.
    pub(in crate::memory) fn task(
        &self,
        findings: &[Value],
    ) -> Result<Option<crate::state::Task>, crate::content::ContentError> {
        Ok(self
            .ask(findings)?
            .map(|a| a.task(crate::state::TaskKind::MatchJudge)))
    }

    /// What the match judge is asked about the asked pairs, `None` when there is none to ask.
    ///
    /// # Errors
    /// When its template or schema is missing.
    pub(in crate::memory) fn ask(
        &self,
        findings: &[Value],
    ) -> Result<Option<super::super::Ask>, crate::content::ContentError> {
        if self.asked.pairs.is_empty() {
            return Ok(None);
        }
        let pairs: Vec<(&PriorDecision, &Value)> = self
            .asked
            .pairs
            .iter()
            .filter_map(|&(fi, di)| Some((self.ds.get(di)?, findings.get(fi)?)))
            .collect();
        Judge::Match.ask(&judge::match_pairs_json(&pairs)).map(Some)
    }
}
