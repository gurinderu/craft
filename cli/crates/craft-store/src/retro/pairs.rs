//! Does a re-review get cheaper because it remembers (realm @nick/craft, nodes #97, #18)? Each
//! top-level review round n+1 is paired with the newest round n of its project, branch and chain
//! filed before it; a pair is compared only when nothing but memory differs ([`checks`]), any other
//! is named with what confounds it and no numbers. Review records that are no round are counted
//! by why, so a missing pair is never silently absent.

use std::collections::BTreeMap;

use crate::js::{Js, JsString, Obj};

pub mod checks;
mod side;

pub use side::{Delta, Side};
use side::{or_zero, side};

/// What a round's record keeps for pairing: the rest of a record (its ledger, its findings) is
/// not read.
const KEPT: [&str; 35] = [
    "schemaVersion",
    "kind",
    "name",
    "driver",
    "project",
    "branch",
    "round",
    "ts",
    "head",
    "base",
    "path",
    "filesDigest",
    "dirty",
    "notRun",
    "gate",
    "verification",
    "verdict",
    "lensScope",
    "intentDigest",
    "specDigest",
    "languages",
    "scout",
    "criticFollowups",
    "optionalPass",
    "strict",
    "depth",
    "reReview",
    "cost",
    "findingsTotal",
    "lensRounds",
    "runtime",
    "craftVersion",
    "workflowEngineRevision",
    "engineRevision",
    "cliRun",
];

/// A round's record cut to what pairing reads; `findings` keeps only its total.
#[must_use]
pub fn kept(r: &Obj) -> Obj {
    let mut o = Obj::new();
    for k in KEPT {
        if let Some(v) = r.get(k) {
            o.set(k, v.clone());
        }
    }
    if let Some(t) = r
        .get("findings")
        .and_then(Js::as_obj)
        .and_then(|f| f.get("total"))
    {
        o.set("findings", Js::Obj(Obj::new().with("total", t.clone())));
    }
    o
}

/// Whether the record is a top-level review round of a branch.
#[must_use]
pub fn is_round(r: &Obj) -> bool {
    let round = r
        .get("round")
        .and_then(Js::as_num)
        .filter(|n| n.fract() == 0.0 && *n >= 1.0);
    r.get("schemaVersion").is_some_and(Js::truthy)
        && r.text_units("kind") == "workflow"
        && super::depth::is_review(r)
        && !r.get("partial").is_some_and(Js::truthy)
        && !r.get("nested").is_some_and(Js::truthy)
        && round.is_some()
        && !r.text_units("branch").is_empty()
}

/// Why a review record is no round; `None` for a round, or a record that is no review run.
#[must_use]
pub fn excluded(r: &Obj) -> Option<&'static str> {
    if r.text_units("kind") != "workflow" || !super::depth::is_review(r) || is_round(r) {
        return None;
    }
    let truthy = |k: &str| r.get(k).is_some_and(Js::truthy);
    let round = r
        .get("round")
        .and_then(Js::as_num)
        .filter(|n| n.fract() == 0.0 && *n >= 1.0);
    Some(if truthy("partial") {
        "did not finish"
    } else if truthy("nested") {
        "nested per-crate run"
    } else if !truthy("schemaVersion") {
        "pre-telemetry"
    } else if round.is_none() {
        "no round"
    } else {
        "no branch (e.g. a detached HEAD)"
    })
}

/// One pair of consecutive rounds.
#[derive(Debug, Clone, PartialEq)]
pub struct Pair {
    pub project: Js,
    pub branch: JsString,
    pub from: Side,
    pub to: Side,
    pub status: &'static str,
}

/// The pairs among `rounds`, ordered by the later round's time.
#[must_use]
#[expect(
    clippy::float_cmp,
    reason = "a round is a whole number, compared exactly as JavaScript does"
)]
pub fn pairs(rounds: &[Obj]) -> Vec<Pair> {
    let mut groups: BTreeMap<(String, JsString, bool), Vec<&Obj>> = BTreeMap::new();
    for r in rounds.iter().filter(|r| is_round(r)) {
        let project = r
            .get("project")
            .map_or_else(|| "undefined".into(), Js::to_js_text)
            .to_utf8_lossy();
        groups
            .entry((project, r.text_units("branch"), super::is_cli(r)))
            .or_default()
            .push(r);
    }
    let ts = |r: &Obj| {
        r.get("ts")
            .map_or_else(|| "undefined".into(), Js::to_js_text)
    };
    let mut out = Vec::new();
    for rs in groups.values() {
        for b in rs {
            let want = or_zero(b.get("round")) - 1.0;
            let mut a: Option<&Obj> = None;
            for r in rs
                .iter()
                .filter(|r| or_zero(r.get("round")) == want && ts(r) < ts(b))
            {
                if a.is_none_or(|a| ts(r) > ts(a)) {
                    a = Some(r);
                }
            }
            if let Some(a) = a {
                out.push(Pair {
                    project: b.get("project").cloned().unwrap_or(Js::Null),
                    branch: b.text_units("branch"),
                    from: side(a),
                    to: side(b),
                    status: checks::status(a, b),
                });
            }
        }
    }
    out.sort_by_key(|p| p.to.ts.to_js_text());
    out
}

#[cfg(test)]
mod tests;
