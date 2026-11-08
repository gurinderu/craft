//! Every finding matched to the record that answers it, with the match judge's verdicts
//! (`matchFindings`, `surePairsToAsk`, `askJudge` in `lib/prior-decision-match.mjs`; realm
//! @nick/craft, nodes #230, #236, #282): the candidate pairs ranked and cut at the judge's bound,
//! then the outright matches the split will raise again, asked about `violates` only; a pair the
//! judge gave no verdict falls back to the title rule, and what it could not decide is named.

use std::collections::BTreeMap;

use serde_json::Value;

use super::super::PriorDecision;
use super::super::judge::{self, CUT_NAMED_MAX, PAIRS_MAX, Verdict};
use super::super::matching::{self, Match, Plan};

const FALLBACK: &str = "not matched unless a near-verbatim title answers them (for a tool finding naming no rule only a tool record with the same title, near its line when lines compare), the rest raised normally";

/// The pairs the judge is asked about, as (finding, record) indices: the candidates first, ranked
/// and cut at the bound, then the re-raised outright matches in the room left.
#[derive(Debug, Clone, Default)]
pub(in crate::memory) struct Asked {
    /// Every candidate pair, ranked: those past `disputed` were cut.
    ranked: Vec<(usize, usize)>,
    pub pairs: Vec<(usize, usize)>,
    /// How many of `pairs` are candidates.
    disputed: usize,
    notes: Vec<String>,
}

impl Asked {
    /// The pairs for `plans`, `reraised` saying of an outright match whether the split raises it
    /// again.
    pub(in crate::memory) fn new(
        findings: &[Value],
        ds: &[PriorDecision],
        plans: &[Plan],
        reraised: &dyn Fn(usize, usize) -> bool,
    ) -> Self {
        let mut ranked: Vec<(usize, usize)> = plans
            .iter()
            .enumerate()
            .flat_map(|(fi, p)| p.disputed.iter().map(move |&di| (fi, di)))
            .collect();
        let rank = |&(fi, di): &(usize, usize)| match (findings.get(fi), ds.get(di)) {
            (Some(f), Some(d)) => matching::pair_rank(f, d),
            _ => u8::MAX,
        };
        ranked.sort_by_key(rank);
        let sent = ranked.len().min(PAIRS_MAX);
        let mut pairs: Vec<(usize, usize)> = ranked.iter().take(sent).copied().collect();
        let sure: Vec<(usize, usize)> = plans
            .iter()
            .enumerate()
            .filter_map(|(fi, p)| Some((fi, p.sure.as_ref()?.at)))
            .filter(|&(fi, di)| reraised(fi, di))
            .collect();
        let room = PAIRS_MAX - sent;
        let mut notes = Vec::new();
        if sure.len() > room {
            notes.push(format!("{} re-raised matched pair(s) past the judge's bound were not asked whether the code goes against the record", sure.len() - room));
        }
        pairs.extend(sure.into_iter().take(room));
        Self {
            ranked,
            pairs,
            disputed: sent,
            notes,
        }
    }
}

/// What the matching made of every finding: its match, the record its code goes against, and the
/// notes and refusals.
#[derive(Debug, Clone, Default)]
pub(in crate::memory) struct Matched {
    pub matches: Vec<Option<Match>>,
    /// The first record (by index) the judge says each finding's code goes against, and why.
    against: BTreeMap<usize, (usize, String)>,
    pub notes: Vec<String>,
    pub refused: Vec<String>,
}

impl Matched {
    /// The record finding `fi`'s code goes against, when no record answers it.
    pub(in crate::memory) fn contradiction(&self, fi: usize) -> Option<&(usize, String)> {
        match self.matches.get(fi) {
            Some(Some(_)) => None,
            _ => self.against.get(&fi),
        }
    }

    /// The record finding `fi`'s code goes against, matched or not: for one raised again.
    pub(in crate::memory) fn violation(&self, fi: usize) -> Option<&(usize, String)> {
        self.against.get(&fi)
    }
}

/// The finding named as a note names a cut pair, with its record.
fn cut_name(f: &Value, d: &PriorDecision) -> String {
    format!("{} ~ {}", judge::finding_name(f), d.id)
}

/// Names the first [`CUT_NAMED_MAX`] of `names` and counts the rest.
fn named(names: &[String]) -> String {
    let more = names.len().saturating_sub(CUT_NAMED_MAX);
    let shown: Vec<&str> = names
        .iter()
        .take(CUT_NAMED_MAX)
        .map(String::as_str)
        .collect();
    let tail = if more > 0 {
        format!(" and {more} more")
    } else {
        String::new()
    };
    format!("{}{tail}", shown.join(", "))
}

/// The verdicts read, and the refusals for what the judge did not decide (`askJudge`).
fn verdicts(
    asked: &Asked,
    answer: Option<&Value>,
    refused: &mut Vec<String>,
) -> BTreeMap<usize, Verdict> {
    let Some(v) = judge::read(answer, asked.pairs.len(), "same") else {
        refused.push(if asked.disputed == 0 {
            format!("the match judge died or answered unreadably — {} re-raised match(es) not asked whether the code goes against the record", asked.pairs.len())
        } else {
            format!("the match judge died or answered unreadably — {} disputed record–finding pair(s) {FALLBACK}", asked.disputed)
        });
        return BTreeMap::new();
    };
    let unjudged = asked.disputed - v.keys().filter(|i| **i < asked.disputed).count();
    if unjudged > 0 {
        refused.push(format!("the match judge returned no verdict for {unjudged} disputed record–finding pair(s) — {FALLBACK}"));
    }
    v
}

/// Matches every finding of `findings` under `plans`, `answer` the judge's answer when it was
/// asked (`None`: it gave none).
pub(in crate::memory) fn matched(
    findings: &[Value],
    ds: &[PriorDecision],
    plans: &[Plan],
    asked: &Asked,
    answer: Option<&Value>,
) -> Matched {
    let mut out = Matched {
        notes: asked.notes.clone(),
        ..Matched::default()
    };
    let cut: Vec<(usize, usize)> = asked.ranked.iter().skip(asked.disputed).copied().collect();
    if !cut.is_empty() {
        let names: Vec<String> = cut
            .iter()
            .filter_map(|&(fi, di)| Some(cut_name(findings.get(fi)?, ds.get(di)?)))
            .collect();
        out.refused.push(format!("{} disputed record–finding pair(s) past the judge's bound of {PAIRS_MAX} were not judged — {FALLBACK}: {}", cut.len(), named(&names)));
    }
    let v = if asked.pairs.is_empty() {
        BTreeMap::new()
    } else {
        verdicts(asked, answer, &mut out.refused)
    };
    let mut by_finding: BTreeMap<usize, BTreeMap<usize, Verdict>> = BTreeMap::new();
    for (i, (fi, di)) in asked.pairs.iter().enumerate() {
        let Some(verdict) = v.get(&i) else { continue };
        if i < asked.disputed {
            by_finding
                .entry(*fi)
                .or_default()
                .insert(*di, verdict.clone());
        }
        if verdict.violates && !out.against.contains_key(fi) {
            out.against.insert(*fi, (*di, verdict.why.clone()));
        }
    }
    if !v.is_empty() {
        out.notes.push(note(&v, asked, out.against.len()));
    }
    out.matches = findings
        .iter()
        .zip(plans)
        .enumerate()
        .map(|(fi, (f, p))| matching::resolve(f, ds, p, by_finding.get(&fi)))
        .collect();
    let plain = titleless(findings, asked, &cut, &by_finding, &out.matches);
    if !plain.is_empty() {
        let names: Vec<String> = plain
            .iter()
            .filter_map(|&fi| findings.get(fi).map(judge::finding_name))
            .collect();
        out.refused.push(format!("{} tool finding(s) naming no rule had a candidate record the judge gave no verdict on (or that fell past its bound) and no tool record with the same title — raised (such a finding is set aside only by the same title or by the judge, never by shared title words): {}", plain.len(), named(&names)));
    }
    out
}

/// The judge's note (`judgeNote`).
fn note(v: &BTreeMap<usize, Verdict>, asked: &Asked, violating: usize) -> String {
    let disputed: Vec<&Verdict> = v
        .iter()
        .filter(|(i, _)| **i < asked.disputed)
        .map(|(_, v)| v)
        .collect();
    let same = disputed.iter().filter(|v| v.same).count();
    let sure = asked.pairs.len() - asked.disputed;
    let sure = if sure > 0 {
        format!(", {sure} re-raised match(es) asked about the record")
    } else {
        String::new()
    };
    let against = if violating > 0 {
        format!(", {violating} showing the code against the record")
    } else {
        String::new()
    };
    format!(
        "match judge: {} disputed pair(s) judged, {same} the same{sure}{against}",
        disputed.len()
    )
}

/// The tool findings naming no rule that a pair the judge did not decide leaves raised, each once,
/// none the cut note names already.
fn titleless(
    findings: &[Value],
    asked: &Asked,
    cut: &[(usize, usize)],
    by_finding: &BTreeMap<usize, BTreeMap<usize, Verdict>>,
    matches: &[Option<Match>],
) -> Vec<usize> {
    let named_cut: Vec<usize> = cut.iter().take(CUT_NAMED_MAX).map(|p| p.0).collect();
    let unnamed = asked
        .pairs
        .iter()
        .take(asked.disputed)
        .chain(cut.iter().skip(CUT_NAMED_MAX));
    let mut out: Vec<usize> = Vec::new();
    for &(fi, di) in unnamed {
        let judged = by_finding.get(&fi).is_some_and(|m| m.contains_key(&di));
        let raised = matches.get(fi).is_none_or(Option::is_none);
        let plain = findings.get(fi).is_some_and(matching::names_no_rule);
        if plain && !named_cut.contains(&fi) && !judged && raised && !out.contains(&fi) {
            out.push(fi);
        }
    }
    out
}
