//! The remembered records applied to a run's findings, as `applyPriorDecisions` in
//! `prior-decision-apply.mjs` (the JavaScript the binary replaced) applies them (realm @nick/craft, nodes #184, #187, #204, #218,
//! #230, #282): a finding a decision answers leaves the verdict and is listed under Rejected before
//! with who, when, why and a link, never dropped; one a deferred question answers under Known and
//! deferred. It is raised again when it is Critical, when it is High and its record is not a human's
//! decision (`decidedBy: "human"`, no deferral; node #196), when its record names no commit and no
//! date, when the repository holds no commit for that anchor, or when the code in the record's
//! scope changed since it (node #676); a High a human's decision sets aside is listed under its
//! own section. Which
//! record answers a finding a near miss leaves open, the match judge decides ([`judged`]): the run
//! is [`prepare`]d, the judge asked about its pairs, then [`apply`] reads its answer. A kept
//! finding the judge says goes against a record is marked with it. A project rule covers a class of
//! findings, not one, and is applied after this split (`memory::rules`).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use super::anchor::{Anchor, before_merge, since_merge};
use super::judge;
use super::matching::{self, Match};
use super::{PriorDecision, RecordKind};

mod judged;
mod mark;
mod prepare;
mod section;

pub(super) use prepare::{Prepared, prepare, prepare_asked};

pub(super) use mark::noted;
use mark::{reraise_reason, reraised_note, set_aside};
pub(super) use section::{refused_section, section};

/// What the scope check observed: the records whose scope is unchanged since their anchor, those
/// whose anchor the repository holds no commit for, and, by id, why where that is other than the
/// commit or a commit before the date missing (a future date, no trunk, git failing), the pull
/// request whose merge a record's scope was compared against, and the records whose scope is
/// unchanged since that merge but changed on the trunk outside the pull request before it — after
/// their decision date, or where the request's branch lacked it (realm @nick/craft, node #682).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Scope {
    pub unchanged: BTreeSet<String>,
    pub missing: BTreeSet<String>,
    pub why_missing: BTreeMap<String, String>,
    pub merged: BTreeMap<String, u64>,
    pub between: BTreeSet<String>,
}

impl Scope {
    /// How `d`'s scope, anchored at `a`, is said to have changed: on the trunk outside the pull
    /// request before the merge it was compared against, since that merge, else since what the
    /// anchor names.
    fn changed(&self, d: &PriorDecision, a: &Anchor<'_>) -> String {
        match self.merged.get(&d.id) {
            Some(n) if self.between.contains(&d.id) => before_merge(*n),
            Some(n) => format!("since {}", since_merge(*n)),
            None => format!("since {}", a.since()),
        }
    }

    /// Why `d`, anchored at `a`, is missing.
    fn missing_why(&self, d: &PriorDecision, a: &Anchor<'_>) -> String {
        self.why_missing
            .get(&d.id)
            .cloned()
            .unwrap_or_else(|| a.missing())
    }
}

/// The findings split: those kept in the verdict (a re-raised one with its note), those set aside
/// with their mark, how many a record answered were raised again, the notes on what was applied,
/// and what could not be.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Applied {
    pub kept: Vec<Value>,
    pub set_aside: Vec<Value>,
    pub reraised: usize,
    pub notes: Vec<String>,
    pub refused: Vec<String>,
}

/// Whether a record can set a finding aside: a deferral needs a commit, a pull request it links or
/// a date to check its scope against (realm @nick/craft, nodes #676, #682).
fn records_deferral(d: &PriorDecision) -> bool {
    d.kind != RecordKind::Question || (d.deferred && d.anchor().is_some())
}

fn or<'a>(s: &'a str, none: &'a str) -> &'a str {
    if s.is_empty() { none } else { s }
}

/// What could not be applied: a deferral without a commit, a pull request or a date, and a matched
/// record whose anchor the repository holds no commit for.
fn refusals(
    findings: &[Value],
    ds: &[PriorDecision],
    matched: &[Option<Match>],
    scope: &Scope,
) -> Vec<String> {
    let mut out: Vec<String> = ds
        .iter()
        .filter(|d| !records_deferral(d))
        .map(|d| format!("question {}: records a deferral but no commit and no date, so an unchanged scope cannot be established — raised normally", d.id))
        .collect();
    let mut seen: Vec<usize> = Vec::new();
    for (f, m) in findings.iter().zip(matched) {
        let Some(m) = m.as_ref().filter(|m| {
            ds.get(m.at)
                .is_some_and(|d| !matching::reraised_by_rank(f, d))
        }) else {
            continue;
        };
        if ds.get(m.at).is_some_and(|d| d.anchor().is_some()) && !seen.contains(&m.at) {
            seen.push(m.at);
        }
    }
    for d in seen.into_iter().filter_map(|i| ds.get(i)) {
        if let Some(a) = d.anchor().filter(|_| scope.missing.contains(&d.id)) {
            let why = scope.missing_why(d, &a);
            out.push(format!("{} {}: {why}", d.kind.label(), d.id));
        }
    }
    out
}

/// Applies the prepared records to `findings`, `answer` the match judge's when it was asked
/// (`None`: it gave none), each mark and note appended to the findings' field `key`.
pub(super) fn apply(
    findings: Vec<Value>,
    p: &Prepared,
    answer: Option<&Value>,
    key: &str,
) -> Applied {
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
    out.refused.clone_from(&m.refused);
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
            out.set_aside.push(set_aside(&f, d, how, key));
        } else {
            reraised += 1;
            let f = noted(&f, key, &reraised_note(d, &why), &[]);
            out.kept.push(judge::mark_contradicting(
                f,
                judge::record_at(&p.ds, m.violation(fi)),
            ));
        }
    }
    out.notes.push(summary(&p.ds, &out.set_aside, reraised));
    out.reraised = reraised;
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
