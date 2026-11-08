//! The project rules applied to a run's findings once the decisions set theirs aside, as
//! `applyProjectRules` in `lib/project-rule-apply.mjs` and `rulePairs` in
//! `lib/project-rule-judge.mjs` apply them (realm @nick/craft, nodes #273, #282): a rule is a
//! stance on a whole class of findings, so its candidates are the findings inside its scope — and
//! of its lens, when it names one — and the rule judge says of each pair whether the finding's
//! concern is exactly what the rule declares acceptable. A finding it puts under a rule leaves the
//! verdict and is listed under its own section; a Critical one is raised even so; one whose pair
//! got no verdict stays, and the section says why. One the judge says goes against a rule is
//! marked with it, unless a decision marked it first.

use std::collections::BTreeSet;

use serde_json::Value;

use super::apply::noted;
use super::judge::{self, CUT_NAMED_MAX, Judge, PAIRS_MAX, WHY_MAX};
use super::matching::{in_scope, reraised_by_severity};
use super::{PriorDecision, RecordKind};
use crate::content::ContentError;
use crate::state::Task;
use crate::tool::{finding_lenses, lens_words};

mod section;
mod verdicts;

pub(super) use section::section;
use verdicts::read;

/// Whether a finding is Critical, which no rule covers.
fn is_critical(f: &Value) -> bool {
    judge::plain(f.get("severity"))
        .trim()
        .eq_ignore_ascii_case("critical")
}

/// Whether rule `r` may cover `f`: its file inside the rule's scope, and, when the rule names a
/// lens, raised by it (`ruleCandidate`).
fn candidate(f: &Value, r: &PriorDecision) -> bool {
    let file = judge::plain(f.get("file"));
    if r.kind != RecordKind::Rule || !in_scope(&file, &r.scope) {
        return false;
    }
    let own = lens_words(&r.lens);
    let lenses = finding_lenses(f);
    own.is_empty() || own.iter().any(|l| lenses.contains(l))
}

/// The rules of a run, and the pairs the judge is asked about.
#[derive(Debug, Clone, Default)]
pub(super) struct Pairs {
    rules: Vec<PriorDecision>,
    superseded: Vec<String>,
    /// Every candidate pair as (finding, rule) indices, ranked: those past [`PAIRS_MAX`] are cut.
    pairs: Vec<(usize, usize)>,
}

impl Pairs {
    /// Every candidate pair as (finding, rule) indices, ranked.
    pub(super) fn pairs(&self) -> &[(usize, usize)] {
        &self.pairs
    }

    /// Takes `pairs` as those asked: the judge's answer is read against what it was handed.
    pub(super) fn asked(&mut self, pairs: Vec<(usize, usize)>) {
        self.pairs = pairs;
    }

    /// Whether any rule applies.
    pub(super) fn any(&self) -> bool {
        !self.rules.is_empty()
    }
}

impl Pairs {
    /// The rules among `records` that apply — those another record supersedes or answers do not
    /// (`activeRules`) — and their pairs with `findings`: findings a rule can cover before High,
    /// before Critical ones (`rulePairs`).
    pub(super) fn new(findings: &[Value], records: &[PriorDecision]) -> Self {
        let replaced: BTreeSet<&String> = records.iter().flat_map(|d| &d.supersedes).collect();
        let (gone, rules): (Vec<&PriorDecision>, Vec<&PriorDecision>) = records
            .iter()
            .filter(|d| d.kind == RecordKind::Rule)
            .partition(|d| {
                std::iter::once(&d.id)
                    .chain(&d.stores)
                    .any(|id| replaced.contains(id))
            });
        let rules: Vec<PriorDecision> = rules.into_iter().cloned().collect();
        let mut pairs: Vec<(usize, usize)> = Vec::new();
        for (fi, f) in findings.iter().enumerate() {
            for (ri, r) in rules.iter().enumerate() {
                if candidate(f, r) {
                    pairs.push((fi, ri));
                }
            }
        }
        let rank = |&(fi, _): &(usize, usize)| match findings.get(fi) {
            Some(f) if is_critical(f) => 2,
            Some(f) if reraised_by_severity(f) => 1,
            _ => 0,
        };
        pairs.sort_by_key(rank);
        Self {
            rules,
            superseded: gone.iter().map(|d| d.id.clone()).collect(),
            pairs,
        }
    }

    pub(super) fn sent(&self) -> usize {
        self.pairs.len().min(PAIRS_MAX)
    }

    /// The rule judge's task over the pairs in its bound, `None` when there is none.
    ///
    /// # Errors
    /// When its template or schema is missing.
    pub(super) fn task(&self, findings: &[Value]) -> Result<Option<Task>, ContentError> {
        if self.pairs.is_empty() {
            return Ok(None);
        }
        let pairs: Vec<(&PriorDecision, &Value)> = self
            .pairs
            .iter()
            .take(self.sent())
            .filter_map(|&(fi, ri)| Some((self.rules.get(ri)?, findings.get(fi)?)))
            .collect();
        Judge::Rule.task(&judge::rule_pairs_json(&pairs)).map(Some)
    }
}

/// The findings the rules left in the verdict, those they covered, the section's notices and the
/// notes.
#[derive(Debug, Clone, Default)]
pub(super) struct Covered {
    pub kept: Vec<Value>,
    pub covered: Vec<Value>,
    pub notices: Vec<String>,
    pub notes: Vec<String>,
}

/// Applies the rules of `p` to `findings`, `answer` the rule judge's when it was asked (`None`:
/// it gave none).
pub(super) fn apply(findings: Vec<Value>, p: &Pairs, answer: Option<&Value>) -> Covered {
    let mut out = Covered::default();
    if !p.superseded.is_empty() {
        out.notes.push(format!(
            "{} project rule(s) superseded by another given record — not applied: {}",
            p.superseded.len(),
            p.superseded.join(", ")
        ));
    }
    if p.pairs.is_empty() {
        if !p.rules.is_empty() {
            out.notes.push(format!(
                "{} project rule(s) given, no finding in their scope",
                p.rules.len()
            ));
        }
        out.kept = findings;
        return out;
    }
    let r = read(p, findings.len(), answer);
    let against = r.against.iter().filter(|a| a.is_some()).count();
    let mut names: Vec<(String, Vec<String>)> = Vec::new();
    for (fi, why) in &r.unjudged {
        let covered = r.covers.get(*fi).is_some_and(Option::is_some);
        let Some(f) = findings.get(*fi).filter(|_| !covered) else {
            continue;
        };
        match names.iter_mut().find(|(w, _)| w == why) {
            Some((_, list)) => list.push(judge::finding_name(f)),
            None => names.push((why.clone(), vec![judge::finding_name(f)])),
        }
    }
    for (fi, f) in findings.into_iter().enumerate() {
        let covers = r.covers.get(fi).and_then(Option::as_ref);
        match judge::record_at(&p.rules, covers) {
            None => {
                let against = r.against.get(fi).and_then(Option::as_ref);
                let against = judge::record_at(&p.rules, against);
                out.kept.push(judge::mark_contradicting(f, against));
            }
            Some((d, why)) if is_critical(&f) => {
                out.notices.push(format!("Critical {} RAISED — a Critical finding is raised even under rule {} \"{}\" (judge: {why})", judge::finding_name(&f), d.id, judge::clip(&d.title, WHY_MAX)));
                let note = format!(
                    "Raised under project rule {}: a Critical finding is never covered by a rule.",
                    d.id
                );
                out.kept.push(noted(&f, &note, &[]));
            }
            Some((d, why)) => out.covered.push(covered(&f, d, why)),
        }
    }
    out.notices.extend(names.into_iter().map(|(why, fs)| {
        let more = fs.len().saturating_sub(CUT_NAMED_MAX);
        let tail = if more > 0 { format!(" and {more} more") } else { String::new() };
        let shown: Vec<&str> = fs.iter().take(CUT_NAMED_MAX).map(String::as_str).collect();
        format!("{} finding(s) in a project rule's scope NOT covered — {why}, so they stay in the verdict: {}{tail}", fs.len(), shown.join(", "))
    }));
    let tail = if against > 0 {
        format!(", {against} showing the code against a rule")
    } else {
        String::new()
    };
    out.notes.push(format!(
        "{} project rule(s) given, {} rule–finding pair(s), {} finding(s) covered{tail}",
        p.rules.len(),
        p.pairs.len(),
        out.covered.len()
    ));
    out
}

/// `f` covered by rule `d`, the judge's `why` its match.
fn covered(f: &Value, d: &PriorDecision, why: &str) -> Value {
    let tier = f
        .get("tier")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .unwrap_or("confirmed");
    noted(
        f,
        &format!("COVERED BY PROJECT RULE: {} (rule {})", d.title, d.id),
        &[
            ("priorTier", Value::from(tier)),
            ("priorDecision", Value::from(d.id.as_str())),
            ("priorKind", Value::from("rule")),
            (
                "priorMatch",
                Value::from(format!("covered by judge: {why}")),
            ),
            ("ruleTitle", Value::from(d.title.as_str())),
        ],
    )
}
