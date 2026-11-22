//! The project rules applied to a run's findings once the decisions set theirs aside, as
//! `applyProjectRules` in `integrations/shared/project-rule-apply.mjs` and `rulePairs` in
//! `integrations/shared/project-rule-judge.mjs` apply them (realm @nick/craft, nodes #273, #282): a rule is a
//! stance on a whole class of findings, so its candidates are the findings inside its scope — and
//! of its lens, when it names one — and the rule judge says of each pair whether the finding's
//! concern is exactly what the rule declares acceptable. A finding it puts under a rule leaves the
//! verdict and is listed under its own section; a Critical one is raised even so; one whose pair
//! got no verdict stays, and the section says why. One the judge says goes against a rule is
//! marked with it, unless a decision marked it first.

use std::collections::BTreeSet;

use serde_json::Value;

use super::apply::noted;
use super::bounds;
use super::judge::{self, CUT_NAMED_MAX, Judge, PAIRS_MAX, WHY_MAX};
use super::matching::in_scope;
use super::{PriorDecision, RecordKind};
use crate::content::ContentError;
use crate::state::Task;
use crate::tool::{finding_lenses, lens_words};

#[cfg(test)]
mod bound_tests;
mod section;
mod verdicts;

/// The most prompts of [`PAIRS_MAX`] pairs one run asks the rule judge (`RULE_JUDGE_PROMPTS_MAX`):
/// a few project-wide rules over a large batch make every finding a candidate of each, and those
/// pairs are all judged up to [`SENT_MAX`]; the rest are named and not covered.
const PROMPTS_MAX: usize = 10;
/// The most pairs one run's rule judges see (`RULE_JUDGE_SENT_MAX`).
const SENT_MAX: usize = PAIRS_MAX * PROMPTS_MAX;

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
    /// Every candidate pair as (finding, rule) indices, ranked: those past [`SENT_MAX`] are cut.
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
    /// (`activeRules`) — and their pairs with `findings`: findings a rule can cover, a High
    /// among them, before Critical ones (`rulePairs`).
    /// Past the bound the pairs of findings on the reviewed `focus` paths go first, then each
    /// finding's first rule before any finding's second ([`bounds::spread`]).
    pub(super) fn new(findings: &[Value], records: &[PriorDecision], focus: &[String]) -> Self {
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
        // A rule covers a High (node #273): only a Critical is raised whatever the verdict.
        let group = |fi: usize, _: usize| {
            findings
                .get(fi)
                .map_or(u8::MAX, |f| u8::from(is_critical(f)))
        };
        pairs.sort_by_key(|&(fi, ri)| group(fi, ri));
        let pairs = bounds::spread(pairs, SENT_MAX, findings, focus, &group);
        Self {
            rules,
            superseded: gone.iter().map(|d| d.id.clone()).collect(),
            pairs,
        }
    }

    pub(super) fn sent(&self) -> usize {
        self.pairs.len().min(SENT_MAX)
    }

    /// The rule judge's tasks over the pairs in its bound, [`PAIRS_MAX`] pairs each — `rule-judge`,
    /// then `rule-judge-2` and on — none when there is no pair.
    ///
    /// # Errors
    /// When its template or schema is missing.
    pub(super) fn tasks(&self, findings: &[Value]) -> Result<Vec<Task>, ContentError> {
        let sent = self.pairs.get(..self.sent()).unwrap_or_default();
        sent.chunks(PAIRS_MAX)
            .enumerate()
            .map(|(k, chunk)| {
                let pairs: Vec<(&PriorDecision, &Value)> = chunk
                    .iter()
                    .filter_map(|&(fi, ri)| Some((self.rules.get(ri)?, findings.get(fi)?)))
                    .collect();
                let mut task = Judge::Rule.task(&judge::rule_pairs_json(&pairs))?;
                if k > 0 {
                    task.id = format!("{}-{}", task.id, k + 1);
                }
                Ok(task)
            })
            .collect()
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

/// Applies the rules of `p` to `findings`, `answers` the rule judges' in their tasks' order (one
/// missing or `None`: that judge gave none).
pub(super) fn apply(findings: Vec<Value>, p: &Pairs, answers: &[Option<Value>]) -> Covered {
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
    let r = read(p, findings.len(), answers);
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
