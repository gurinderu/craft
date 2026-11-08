//! Which remembered record answers a finding, as `lib/prior-decision-match.mjs` matches them
//! without its judge (realm @nick/craft, nodes #187, #230, #236): a record whose scope holds the
//! finding's file, of the finding's lens, its line within a few lines of the finding's (and, for a
//! gate tool's finding, the same tool rule) answers it outright; any other candidate answers it
//! only by the title rule — titles sharing most of their words — or, for a tool finding naming no
//! rule, only by the same title — unless the match judge gave that pair a verdict ([`resolve`]).
//! A record that overrides another is tried before it.

use std::collections::BTreeMap;

use serde_json::Value;

use super::judge::Verdict;

use super::PriorDecision;
use super::record::scope_parts;
use crate::ledger::overlap;
use crate::tool::{self, finding_lenses, is_tool_finding, is_tool_lens, lens_words};

/// How far apart a record's line and a finding's may be and still make the pair a candidate.
const LINE_WINDOW: u64 = 15;
/// How far apart they may be, with the same lens, to match outright.
const SURE_WINDOW: u64 = 3;
/// The title overlap that makes a record a candidate.
const CANDIDATE_OVERLAP: f64 = 0.3;
/// The title overlap that matches a candidate by the title rule alone.
const TITLE_OVERLAP: f64 = 0.6;

const BY_ANCHOR: &str = "matched by file:line+lens";
const BY_RULE: &str = "matched by file:line+lens+toolRule";
const BY_TOOL_TITLE: &str = "matched by file:line+lens+title";
const BY_FILE_TITLE: &str = "matched by file+lens+title";
const BY_TITLE: &str = "matched by title words (the judge gave no verdict)";
const BY_SAME_TITLE: &str = "matched by the same title near its line (the judge gave no verdict)";
const BY_SAME_TITLE_IN_SCOPE: &str =
    "matched by the same title in scope, no line to compare (the judge gave no verdict)";

/// The record that answers a finding, by its index, and how that was established.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Match {
    pub at: usize,
    pub how: String,
}

/// One finding against the records in tried order (`findingPlan`): the first outright match, and
/// the candidates tried before it, which the judge decides first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Plan {
    pub sure: Option<Match>,
    pub disputed: Vec<usize>,
}

fn text<'a>(f: &'a Value, k: &str) -> &'a str {
    f.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Whether `file` sits inside `scope`, by path segments; `.` covers the repository.
pub(super) fn in_scope(file: &str, scope: &str) -> bool {
    let (parts, within) = (scope_parts(file), scope_parts(scope));
    !parts.is_empty()
        && within.len() <= parts.len()
        && within.iter().zip(&parts).all(|(a, b)| a == b)
}

/// Whether a severity is Critical or High, which no record sets aside.
pub(super) fn reraised_by_severity(f: &Value) -> bool {
    let s = text(f, "severity").trim().to_lowercase();
    s == "critical" || s == "high"
}

/// A finding's line when it is a positive whole number, else 0.
fn finding_line(f: &Value) -> u64 {
    match f.get("line") {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// Whether a tool finding names no rule (`namesNoRule`).
pub(super) fn names_no_rule(f: &Value) -> bool {
    is_tool_finding(f) && tool::rule_key(f).is_empty()
}

/// Whether a finding names no rule because its tool prints none: deadnix, fmt, or a source-less
/// seed (`isRulelessToolFinding`).
fn ruleless(f: &Value) -> bool {
    names_no_rule(f)
        && finding_lenses(f)
            .iter()
            .filter(|l| is_tool_lens(l))
            .all(|l| matches!(l.as_str(), "tool" | "deadnix" | "fmt"))
}

/// How the record's tool rule stands to a finding's (`ruleOf`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rule {
    Any,
    Same,
    Title,
    Other,
    Unknown,
}

fn rule_of(f: &Value, d: &PriorDecision) -> Rule {
    if !is_tool_finding(f) {
        return Rule::Any;
    }
    if ruleless(f) {
        let t = tool::title_key_of(text(f, "title"));
        let same = !t.is_empty() && t == tool::title_key_of(&d.title);
        return if tool::rule_key_of(&d.tool_rule).is_empty() && same {
            Rule::Title
        } else {
            Rule::Unknown
        };
    }
    let (mine, theirs) = (tool::rule_key(f), tool::rule_key_of(&d.tool_rule));
    match (mine.is_empty() || theirs.is_empty(), mine == theirs) {
        (true, _) => Rule::Unknown,
        (false, true) => Rule::Same,
        (false, false) => Rule::Other,
    }
}

/// How the record's anchor meets the finding's (`anchorOf`, `placeGap`).
#[derive(Debug, Clone, Copy)]
struct Anchor {
    near: bool,
    sure: bool,
    same: bool,
    whole: bool,
}

fn anchor_of(f: &Value, d: &PriorDecision) -> Anchor {
    let line = finding_line(f);
    let file = text(f, "file");
    // A line anchors only inside one file: a directory or `.` scope compares no line.
    let one_file = in_scope(&d.scope, file);
    let whole = d.line == 0 && line == 0 && one_file && ruleless(f);
    let gap = if d.line > 0 && line > 0 && one_file {
        Some(line.abs_diff(d.line))
    } else {
        whole.then_some(0)
    };
    let own = lens_words(&d.lens);
    let lenses = finding_lenses(f);
    let same = !own.is_empty() && !lenses.is_empty() && own.iter().any(|l| lenses.contains(l));
    Anchor {
        near: gap.is_some_and(|g| g <= LINE_WINDOW),
        sure: gap.is_some_and(|g| g <= SURE_WINDOW),
        same,
        whole,
    }
}

/// How a record stands to a finding: answering it outright, a candidate, or neither.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    Anchored,
    Disputed,
    Neither,
}

fn class(f: &Value, d: &PriorDecision) -> Class {
    if !in_scope(text(f, "file"), &d.scope) {
        return Class::Neither;
    }
    let rule = rule_of(f, d);
    if rule == Rule::Other {
        return Class::Neither;
    }
    let a = anchor_of(f, d);
    if a.sure && a.same && rule != Rule::Unknown {
        return Class::Anchored;
    }
    if a.near || a.same || overlap(text(f, "title"), &d.title) >= CANDIDATE_OVERLAP {
        Class::Disputed
    } else {
        Class::Neither
    }
}

/// How an outright match was established.
fn sure_how(f: &Value, d: &PriorDecision) -> &'static str {
    if anchor_of(f, d).whole {
        return BY_FILE_TITLE;
    }
    match rule_of(f, d) {
        Rule::Same => BY_RULE,
        Rule::Title => BY_TOOL_TITLE,
        Rule::Any | Rule::Other | Rule::Unknown => BY_ANCHOR,
    }
}

/// Whether a record comes from a gate tool's lens, or carries none (an old record).
fn from_tool_lens(d: &PriorDecision) -> bool {
    let own = lens_words(&d.lens);
    own.is_empty() || own.iter().any(|l| is_tool_lens(l))
}

/// How a record answers a tool finding naming no rule by its same title; '' when it does not.
fn same_title_of(f: &Value, d: &PriorDecision) -> &'static str {
    let t = tool::title_key_of(text(f, "title"));
    let file = text(f, "file");
    if t.is_empty()
        || t != tool::title_key_of(&d.title)
        || !in_scope(file, &d.scope)
        || !from_tool_lens(d)
    {
        return "";
    }
    let compares = d.line > 0 && finding_line(f) > 0 && in_scope(&d.scope, file);
    match (compares, anchor_of(f, d).near) {
        (false, _) => BY_SAME_TITLE_IN_SCOPE,
        (true, true) => BY_SAME_TITLE,
        (true, false) => "",
    }
}

/// How a candidate answers a finding with no judge to ask; '' when it does not.
fn unjudged(f: &Value, d: &PriorDecision) -> &'static str {
    if names_no_rule(f) {
        return same_title_of(f, d);
    }
    let answers =
        in_scope(text(f, "file"), &d.scope) && overlap(text(f, "title"), &d.title) >= TITLE_OVERLAP;
    if answers { BY_TITLE } else { "" }
}

/// How `f` stands to the records in tried `order` (`findingPlan`).
pub(super) fn plan(f: &Value, ds: &[PriorDecision], order: &[usize]) -> Plan {
    let mut out = Plan::default();
    for &at in order {
        let Some(d) = ds.get(at) else { continue };
        match class(f, d) {
            Class::Anchored => {
                out.sure = Some(Match {
                    at,
                    how: sure_how(f, d).to_owned(),
                });
                break;
            }
            Class::Disputed => out.disputed.push(at),
            Class::Neither => {}
        }
    }
    out
}

/// The record answering `f` under `plan`, given the judge's verdicts on its candidates by record
/// index (`resolvePlan`): in tried order, a candidate judged the same; one without a verdict that
/// answers it by its title; else the outright match.
pub(super) fn resolve(
    f: &Value,
    ds: &[PriorDecision],
    plan: &Plan,
    judged: Option<&BTreeMap<usize, Verdict>>,
) -> Option<Match> {
    for &at in &plan.disputed {
        match judged.and_then(|j| j.get(&at)) {
            Some(v) if v.same => {
                return Some(Match {
                    at,
                    how: format!("matched by judge: {}", v.why),
                });
            }
            Some(_) => {}
            None => {
                let how = ds.get(at).map_or("", |d| unjudged(f, d));
                if !how.is_empty() {
                    return Some(Match {
                        at,
                        how: how.to_owned(),
                    });
                }
            }
        }
    }
    plan.sure.clone()
}

/// A candidate pair's rank under the judge's bound, lowest first (`pairRank`): findings a record
/// may set aside before Critical and High ones, and within each a near line before a shared lens
/// before title words alone.
pub(super) fn pair_rank(f: &Value, d: &PriorDecision) -> u8 {
    let a = anchor_of(f, d);
    let place = if a.near {
        0
    } else if a.same {
        1
    } else {
        2
    };
    if reraised_by_severity(f) {
        3 + place
    } else {
        place
    }
}

/// The records in the order they are tried: those overriding another first (`triedOrder`).
pub(super) fn tried_order(ds: &[PriorDecision]) -> Vec<usize> {
    let (first, rest): (Vec<usize>, Vec<usize>) =
        (0..ds.len()).partition(|&i| ds.get(i).is_some_and(|d| !d.overrides.is_empty()));
    first.into_iter().chain(rest).collect()
}
