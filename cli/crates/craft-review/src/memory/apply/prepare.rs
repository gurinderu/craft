//! A run's records made ready for the match judge (`applyPriorDecisions` up to its judge call):
//! those that apply, their scopes observed by git, each finding's candidates and the pairs the
//! judge is asked about.

use std::collections::BTreeSet;

use serde_json::Value;

use super::super::judge::{self, Judge};
use super::super::matching::{self, Plan};
use super::super::{PriorDecision, RecordKind};
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
/// aside and that names a commit, each once.
fn to_check<'a>(
    findings: &[Value],
    ds: &'a [PriorDecision],
    plans: &[Plan],
) -> Vec<&'a PriorDecision> {
    let mut at: Vec<usize> = Vec::new();
    for (_, p) in findings
        .iter()
        .zip(plans)
        .filter(|(f, _)| !matching::reraised_by_severity(f))
    {
        for i in p
            .disputed
            .iter()
            .copied()
            .chain(p.sure.as_ref().map(|m| m.at))
        {
            if ds.get(i).is_some_and(|d| !d.commit.is_empty()) && !at.contains(&i) {
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

/// Readies `records` for `findings` (none refuted), `check` observing the scopes of the records it
/// is handed (never none). The scope check runs first, so the one judge call is also asked about
/// the outright matches it raises again.
pub(in crate::memory) fn prepare(
    findings: &[Value],
    records: &[PriorDecision],
    check: &dyn Fn(&[&PriorDecision]) -> Scope,
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
    scope
        .missing
        .retain(|id| checked.iter().any(|d| &d.id == id));
    let reraised = |fi: usize, di: usize| match (findings.get(fi), ds.get(di)) {
        (Some(f), Some(d)) => !reraise_reason(f, d, &scope).is_empty(),
        _ => false,
    };
    let asked = Asked::new(findings, &ds, &plans, &reraised);
    Prepared {
        ds,
        scope,
        plans,
        asked,
        notes,
    }
}

impl Prepared {
    /// The match judge's task over the asked pairs, `None` when there is none to ask.
    ///
    /// # Errors
    /// When its template or schema is missing.
    pub(in crate::memory) fn task(
        &self,
        findings: &[Value],
    ) -> Result<Option<crate::state::Task>, crate::content::ContentError> {
        if self.asked.pairs.is_empty() {
            return Ok(None);
        }
        let pairs: Vec<(&PriorDecision, &Value)> = self
            .asked
            .pairs
            .iter()
            .filter_map(|&(fi, di)| Some((self.ds.get(di)?, findings.get(fi)?)))
            .collect();
        Judge::Match
            .task(&judge::match_pairs_json(&pairs))
            .map(Some)
    }
}
