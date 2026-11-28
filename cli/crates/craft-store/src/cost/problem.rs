//! Whether a stored cost can be used as a cost — the one rule every reader of the store applies,
//! `costProblem` in `integrations/shared/run-record.mjs`; both are held to
//! `content/parity/cost-problem-cases.json` (realm @nick/craft, nodes #357, #393, #658).

use super::{COST_RULE, COST_RULE_PER_LINE};
use crate::js::{Js, Obj};

/// Why a cost is not usable, worst first as the rule tests them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Problem {
    /// Never enriched.
    Missing,
    /// Not a cost's shape: no measured field, a field that is not a count, a bad label or slice,
    /// or a total that is not the sum of its parts.
    Malformed,
    /// Written, but measured nothing.
    Empty,
    /// Summed per transcript line: no rule, or the per-line one.
    Overcounted,
    /// A rule this reader does not know.
    UnknownRule,
    /// Skipped transcripts or unmeasured parts make the total a lower bound.
    Partial,
}

impl Problem {
    /// The name the JavaScript rule gives it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Malformed => "malformed",
            Self::Empty => "empty",
            Self::Overcounted => "overcounted",
            Self::UnknownRule => "unknown-rule",
            Self::Partial => "partial",
        }
    }
}

const PARTS: [&str; 4] = ["cacheRead", "cacheWrite", "input", "output"];
const MEASURED: [&str; 6] = [
    "total",
    "cacheRead",
    "cacheWrite",
    "input",
    "output",
    "agents",
];
const LOWER: [&str; 2] = ["skipped", "partsUnmeasured"];

/// `isCount`: a finite number, not below zero.
fn count(v: &Js) -> Option<f64> {
    v.as_num().filter(|n| n.is_finite() && *n >= 0.0)
}

/// `isWhole`: a count that is an integer.
fn whole(v: &Js) -> Option<f64> {
    count(v).filter(|n| n.fract() == 0.0)
}

/// `c[k] != null`: present and not null.
fn present<'a>(c: &'a Obj, k: &str) -> Option<&'a Js> {
    c.get(k).filter(|v| **v != Js::Null)
}

fn parts_sum(c: &Obj) -> f64 {
    PARTS.iter().filter_map(|k| c.get(*k).and_then(count)).sum()
}

/// The total a stored cost stands for: `total` when it is a count, else the sum of its parts.
#[must_use]
pub fn total(c: &Obj) -> f64 {
    c.get("total")
        .and_then(count)
        .unwrap_or_else(|| parts_sum(c))
}

/// Why `cost`, a record's `cost` field, is not usable; `None` when it is.
#[must_use]
pub fn problem(cost: Option<&Js>) -> Option<Problem> {
    let c = match cost {
        None | Some(Js::Null) => return Some(Problem::Missing),
        Some(Js::Obj(c)) => c,
        Some(_) => return Some(Problem::Malformed),
    };
    if malformed(c) {
        return Some(Problem::Malformed);
    }
    if total(c) <= 0.0 {
        return Some(Problem::Empty);
    }
    match present(c, "rule").and_then(Js::as_str) {
        None => return Some(Problem::Overcounted),
        Some(r) if r == COST_RULE_PER_LINE => return Some(Problem::Overcounted),
        Some(r) if r != COST_RULE => return Some(Problem::UnknownRule),
        Some(_) => {}
    }
    let lower = LOWER
        .iter()
        .any(|k| c.get(*k).and_then(count).is_some_and(|n| n > 0.0));
    lower.then_some(Problem::Partial)
}

#[expect(
    clippy::float_cmp,
    reason = "the JavaScript rule compares exactly: a total off by any amount is not the sum"
)]
fn malformed(c: &Obj) -> bool {
    if MEASURED.iter().all(|k| present(c, k).is_none()) {
        return true;
    }
    let not_count = |k: &&str| present(c, k).is_some_and(|v| count(v).is_none());
    if MEASURED.iter().chain(LOWER.iter()).any(not_count) || label_malformed(c) {
        return true;
    }
    let total = c.get("total").and_then(count);
    total.is_some_and(|t| PARTS.iter().any(|k| present(c, k).is_some()) && t != parts_sum(c))
}

/// A `source` that is not a non-empty string, a `rule` that is not a string, or a `slice` that is
/// not a run's slice.
fn label_malformed(c: &Obj) -> bool {
    present(c, "source").is_some_and(|s| s.as_str().is_none_or(str::is_empty))
        || present(c, "rule").is_some_and(|r| r.as_str().is_none())
        || present(c, "slice").is_some_and(|s| !is_slice(s))
}

/// `costSlice`: record `index` of the `of` one run filed, and `tail`, a whole count, if any.
pub(super) fn is_slice(s: &Js) -> bool {
    let Some(o) = s.as_obj() else {
        return false;
    };
    let (Some(index), Some(of)) = (o.get("index").and_then(whole), o.get("of").and_then(whole))
    else {
        return false;
    };
    index >= 1.0 && index <= of && present(o, "tail").is_none_or(|t| whole(t).is_some())
}
