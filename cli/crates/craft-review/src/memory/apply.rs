//! The remembered records applied to a run's findings, as `applyPriorDecisions` in
//! `lib/prior-decision-apply.mjs` applies them (realm @nick/craft, nodes #184, #187, #204, #218,
//! #230, #282): a finding a decision answers leaves the verdict and is listed under Rejected before
//! with who, when, why and a link, never dropped; one a deferred question answers under Known and
//! deferred. It is raised again when it is Critical or High, when its record names no commit, when
//! the repository lacks that commit, or when the code in the record's scope changed since it. Which
//! record answers a finding a near miss leaves open, the match judge decides ([`judged`]): the run
//! is [`prepare`]d, the judge asked about its pairs, then [`apply`] reads its answer. A kept
//! finding the judge says goes against a record is marked with it. A project rule covers a class of
//! findings, not one, and is applied after this split (`memory::rules`).

use std::collections::BTreeSet;

use serde_json::{Value, json};

use super::judge;
use super::matching::{self, Match};
use super::{PriorDecision, RecordKind};

mod judged;
mod mark;
mod prepare;
mod section;

pub(super) use prepare::{Prepared, prepare};

pub(super) use mark::noted;
use mark::{commit_missing, reraise_reason, reraised_note, set_aside};
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

/// Whether a record can set a finding aside: a deferral needs a commit to check its scope against.
fn records_deferral(d: &PriorDecision) -> bool {
    d.kind != RecordKind::Question || (d.deferred && !d.commit.is_empty())
}

fn or<'a>(s: &'a str, none: &'a str) -> &'a str {
    if s.is_empty() { none } else { s }
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
        let Some(m) = m.as_ref().filter(|_| !matching::reraised_by_severity(f)) else {
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

/// Applies the prepared records to `findings`, `answer` the match judge's when it was asked
/// (`None`: it gave none).
pub(super) fn apply(findings: Vec<Value>, p: Prepared, answer: Option<&Value>) -> Applied {
    let mut out = Applied {
        notes: p.notes.clone(),
        ..Applied::default()
    };
    if p.ds.is_empty() {
        out.kept = findings;
        return out;
    }
    let m = judged::matched(&findings, &p.ds, &p.plans, &p.asked, answer);
    out.notes.extend(m.notes.iter().cloned());
    out.refused = m.refused.clone();
    out.refused
        .extend(refusals(&findings, &p.ds, &m.matches, &p.scope));
    let mut reraised = 0;
    for (fi, f) in findings.into_iter().enumerate() {
        let Some((d, how)) = m
            .matches
            .get(fi)
            .and_then(Option::as_ref)
            .and_then(|x| Some((p.ds.get(x.at)?, x.how.as_str())))
        else {
            out.kept.push(judge::mark_contradicting(
                f,
                judge::record_at(&p.ds, m.contradiction(fi)),
            ));
            continue;
        };
        let why = reraise_reason(&f, d, &p.scope);
        if why.is_empty() {
            out.set_aside.push(set_aside(&f, d, how));
        } else {
            reraised += 1;
            let f = noted(&f, &reraised_note(d, &why), &[]);
            out.kept.push(judge::mark_contradicting(
                f,
                judge::record_at(&p.ds, m.violation(fi)),
            ));
        }
    }
    out.notes.push(summary(&p.ds, &out.set_aside, reraised));
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
