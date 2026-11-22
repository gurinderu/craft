//! What the rule judge said of each finding (`ruleVerdicts`, `ruleContradictions` in
//! `integrations/shared/project-rule-apply.mjs`).

use std::collections::BTreeMap;

use serde_json::Value;

use super::super::judge::{self, PAIRS_MAX, Verdict};
use super::{Pairs, SENT_MAX};

/// Per finding: the first rule (in pair order) the judge put it under, the first it goes against,
/// and why a finding with a pair the judge did not decide stays (`ruleVerdicts`).
#[derive(Debug, Default)]
pub(super) struct Read {
    pub covers: Vec<Option<(usize, String)>>,
    pub against: Vec<Option<(usize, String)>>,
    pub unjudged: Vec<(usize, String)>,
}

/// The verdicts of `answers` (the judges' in their tasks' order, [`PAIRS_MAX`] pairs each) over
/// `p`'s pairs among `n` findings; a judge that gave none leaves its own pairs unjudged.
pub(super) fn read(p: &Pairs, n: usize, answers: &[Option<Value>]) -> Read {
    let sent = p.sent();
    let mut verdicts: BTreeMap<usize, Verdict> = BTreeMap::new();
    let mut whys: Vec<&str> = Vec::new();
    for (k, at) in (0..sent).step_by(PAIRS_MAX).enumerate() {
        let len = (sent - at).min(PAIRS_MAX);
        let answer = answers.get(k).and_then(Option::as_ref);
        match judge::read(answer, len, "covered") {
            Some(v) => {
                verdicts.extend(v.into_iter().map(|(i, v)| (at + i, v)));
                whys.push("the rule judge returned no verdict for it");
            }
            None => whys.push("the rule judge died or answered unreadably"),
        }
    }
    let mut out = Read {
        covers: vec![None; n],
        against: vec![None; n],
        unjudged: Vec::new(),
    };
    for (i, &(fi, ri)) in p.pairs().iter().enumerate() {
        let v: Option<&Verdict> = verdicts.get(&i);
        let first = |slot: Option<&mut Option<(usize, String)>>, v: &Verdict| {
            if let Some(s) = slot.filter(|s| s.is_none()) {
                *s = Some((ri, v.why.clone()));
            }
        };
        match v {
            Some(v) if v.same => first(out.covers.get_mut(fi), v),
            Some(v) if v.violates => first(out.against.get_mut(fi), v),
            None if !out.unjudged.iter().any(|(f, _)| *f == fi) => {
                let why = match whys.get(i / PAIRS_MAX).filter(|_| i < sent) {
                    Some(w) => (*w).to_owned(),
                    None => format!(
                        "past the rule judge's bound of {SENT_MAX} pairs — judged first were the findings on the reviewed paths, then those a rule can cover (a High among them) before Critical ones, then each finding's first rule before any finding's second; narrow the rule's scope or lens, or review a narrower path (path=<dir>)"
                    ),
                };
                out.unjudged.push((fi, why));
            }
            Some(_) | None => {}
        }
    }
    out
}
