//! What the rule judge said of each finding (`ruleVerdicts`, `ruleContradictions` in
//! `integrations/shared/project-rule-apply.mjs`).

use std::collections::BTreeMap;

use serde_json::Value;

use super::super::judge::{self, PAIRS_MAX, Verdict};
use super::Pairs;

/// Per finding: the first rule (in pair order) the judge put it under, the first it goes against,
/// and why a finding with a pair the judge did not decide stays (`ruleVerdicts`).
#[derive(Debug, Default)]
pub(super) struct Read {
    pub covers: Vec<Option<(usize, String)>>,
    pub against: Vec<Option<(usize, String)>>,
    pub unjudged: Vec<(usize, String)>,
}

/// The verdicts of `answer` over `p`'s pairs among `n` findings.
pub(super) fn read(p: &Pairs, n: usize, answer: Option<&Value>) -> Read {
    let sent = p.sent();
    let (verdicts, why) = match judge::read(answer, sent, "covered") {
        Some(v) => (v, "the rule judge returned no verdict for it"),
        None => (
            BTreeMap::new(),
            "the rule judge died or answered unreadably",
        ),
    };
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
                let why = if i < sent {
                    why.to_owned()
                } else {
                    format!(
                        "past the rule judge's bound of {PAIRS_MAX} pairs — judged first were the findings on the reviewed paths, each finding's first rule before any finding's second; narrow the rule's scope or lens, or review a narrower path (path=<dir>)"
                    )
                };
                out.unjudged.push((fi, why));
            }
            Some(_) | None => {}
        }
    }
    out
}
