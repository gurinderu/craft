//! The remembered records applied to a run's findings, as `applyPriorDecisions` in
//! `lib/prior-decision-apply.mjs` applies them without its match judge (realm @nick/craft, nodes
//! #184, #187, #204, #218): a finding a decision answers leaves the verdict and is listed under
//! Rejected before with who, when, why and a link, never dropped; one a deferred question answers
//! under Known and deferred. It is raised again when it is Critical or High, when its record names
//! no commit, when the repository lacks that commit, or when the code in the record's scope changed
//! since it. A project rule covers a class of findings, not one, and is not applied here.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::matching::{self, Match};
use super::{PriorDecision, RecordKind};

mod mark;
mod section;

use mark::{commit_missing, noted, reraise_reason, reraised_note, set_aside};
pub(super) use section::{refused_section, section};

/// What the scope check observed: the records whose scope is unchanged since their commit, and
/// those whose commit the repository lacks.
#[derive(Debug, Clone, Default)]
pub(super) struct Scope {
    pub unchanged: BTreeSet<String>,
    pub missing: BTreeSet<String>,
}

/// The findings split: those kept in the verdict (a re-raised one with its note), those set aside
/// with their mark, the notes on what was applied, and what could not be.
#[derive(Debug, Clone, Default)]
pub(super) struct Applied {
    pub kept: Vec<Value>,
    pub set_aside: Vec<Value>,
    pub notes: Vec<String>,
    pub refused: Vec<String>,
}

/// Whether a record is matched against findings: every decision, a question only when it records
/// a deferral (`matchesFindings`); any other question is context.
fn matches_findings(d: &PriorDecision) -> bool {
    d.kind != RecordKind::Question || d.deferred
}

/// Whether a record can set a finding aside: a deferral needs a commit to check its scope against.
fn records_deferral(d: &PriorDecision) -> bool {
    d.kind != RecordKind::Question || (d.deferred && !d.commit.is_empty())
}

/// Every id a record is known by: its own and the store's.
fn aliases(d: &PriorDecision) -> impl Iterator<Item = &String> {
    std::iter::once(&d.id).chain(&d.stores)
}

fn or<'a>(s: &'a str, none: &'a str) -> &'a str {
    if s.is_empty() { none } else { s }
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
    order: &[usize],
) -> Vec<&'a PriorDecision> {
    let mut at: Vec<usize> = Vec::new();
    for f in findings
        .iter()
        .filter(|f| !matching::reraised_by_severity(f))
    {
        for i in matching::candidates(f, ds, order) {
            if ds.get(i).is_some_and(|d| !d.commit.is_empty()) && !at.contains(&i) {
                at.push(i);
            }
        }
    }
    at.into_iter().filter_map(|i| ds.get(i)).collect()
}

/// What could not be applied: a deferral without a commit, and a matched record whose commit the
/// repository lacks.
fn refusals(
    findings: &[Value],
    ds: &[PriorDecision],
    matched: &[Option<Match>],
    scope: &Scope,
) -> Vec<String> {
    let mut out: Vec<String> = ds
        .iter()
        .filter(|d| !records_deferral(d))
        .map(|d| format!("question {}: records a deferral but no commit, so an unchanged scope cannot be established — raised normally", d.id))
        .collect();
    let mut seen: Vec<usize> = Vec::new();
    for (f, m) in findings.iter().zip(matched) {
        let Some(m) = m.filter(|_| !matching::reraised_by_severity(f)) else {
            continue;
        };
        if ds.get(m.at).is_some_and(|d| !d.commit.is_empty()) && !seen.contains(&m.at) {
            seen.push(m.at);
        }
    }
    for d in seen.into_iter().filter_map(|i| ds.get(i)) {
        if scope.missing.contains(&d.id) {
            out.push(format!(
                "{} {}: {}",
                d.kind.label(),
                d.id,
                commit_missing(d)
            ));
        }
    }
    out
}

/// Applies `records` to `findings` (none refuted), `check` observing the scopes of the records it
/// is handed (never none).
pub(super) fn apply(
    findings: Vec<Value>,
    records: &[PriorDecision],
    check: &dyn Fn(&[&PriorDecision]) -> Scope,
) -> Applied {
    let mut out = Applied::default();
    let ds = applicable(records, &mut out.notes);
    if ds.is_empty() {
        out.kept = findings;
        return out;
    }
    let order = matching::tried_order(&ds);
    let checked = to_check(&findings, &ds, &order);
    let mut scope = if checked.is_empty() {
        Scope::default()
    } else {
        check(&checked)
    };
    scope
        .missing
        .retain(|id| checked.iter().any(|d| &d.id == id));
    let matched: Vec<Option<Match>> = findings
        .iter()
        .map(|f| matching::match_of(f, &ds, &order))
        .collect();
    out.refused = refusals(&findings, &ds, &matched, &scope);
    let mut reraised = 0;
    for (f, m) in findings.iter().zip(&matched) {
        let Some((d, m)) = m.and_then(|m| Some((ds.get(m.at)?, m))) else {
            out.kept.push(f.clone());
            continue;
        };
        let why = reraise_reason(f, d, &scope);
        if why.is_empty() {
            out.set_aside.push(set_aside(f, d, m.how));
        } else {
            reraised += 1;
            out.kept.push(noted(f, &reraised_note(d, &why), &[]));
        }
    }
    out.notes.push(summary(&ds, &out.set_aside, reraised));
    out
}

/// What the split did, as one note.
fn summary(ds: &[PriorDecision], set_aside: &[Value], reraised: usize) -> String {
    let questions = ds.iter().filter(|d| d.kind == RecordKind::Question).count();
    let deferred = set_aside
        .iter()
        .filter(|f| f.get("priorKind") == Some(&json!("question")))
        .count();
    let tail = if questions > 0 {
        format!(
            "; {questions} deferred question(s) given, {deferred} finding(s) set aside as known and deferred"
        )
    } else {
        String::new()
    };
    format!(
        "{} decision(s) given, {} finding(s) set aside as rejected before, {reraised} raised again{tail}",
        ds.len() - questions,
        set_aside.len() - deferred
    )
}
