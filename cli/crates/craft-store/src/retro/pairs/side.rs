//! One round's side of a pair, and a clean pair's delta.

use crate::cost::problem::{self, Problem};
use crate::js::{Js, JsString, Obj};

use super::Pair;

/// One round's side of a pair: its cost by part (`None` without a cost whose numbers read) and counts.
#[derive(Debug, Clone, PartialEq)]
pub struct Side {
    pub ts: Js,
    pub round: f64,
    pub head: JsString,
    /// Total, cache read, cache write, input, output, agents.
    pub cost: Option<[f64; 6]>,
    pub lens_agents: f64,
    pub candidates: f64,
    pub findings: f64,
}

/// `Number(v) || 0`.
pub(super) fn or_zero(v: Option<&Js>) -> f64 {
    let n = v.map_or(f64::NAN, Js::to_js_number);
    if n.is_nan() { 0.0 } else { n }
}

pub(super) fn side(r: &Obj) -> Side {
    let cost = r.get("cost");
    let usable = matches!(problem::problem(cost), None | Some(Problem::Partial));
    let c = cost.and_then(Js::as_obj).filter(|_| usable);
    let part = |c: &Obj, k: &str| or_zero(c.get(k));
    let total = r
        .get("findings")
        .and_then(Js::as_obj)
        .and_then(|f| f.get("total"))
        .filter(|v| **v != Js::Null)
        .or_else(|| r.get("findingsTotal"));
    let rows = r.get("lensRounds").and_then(Js::as_arr).unwrap_or(&[]);
    Side {
        ts: r.get("ts").cloned().unwrap_or(Js::Null),
        round: or_zero(r.get("round")),
        head: r
            .get("head")
            .filter(|v| v.truthy())
            .map(Js::to_js_text)
            .unwrap_or_default(),
        cost: c.map(|c| {
            [
                problem::total(c),
                part(c, "cacheRead"),
                part(c, "cacheWrite"),
                part(c, "input"),
                part(c, "output"),
                part(c, "agents"),
            ]
        }),
        lens_agents: rows
            .iter()
            .map(|x| or_zero(x.as_obj().and_then(|o| o.get("agents"))))
            .sum(),
        candidates: or_zero(
            r.get("verification")
                .and_then(Js::as_obj)
                .and_then(|v| v.get("candidates")),
        ),
        findings: or_zero(total),
    }
}

/// A clean pair's later round minus its earlier: total, cache read, cache write, input, output,
/// agents, lens dispatches, candidates, findings; the total's ratio to two places; the minutes
/// apart, `None` when a time does not read.
#[derive(Debug, Clone, PartialEq)]
pub struct Delta {
    pub by: [f64; 9],
    pub ratio: f64,
    pub minutes: Option<f64>,
}

fn ms(ts: &Js) -> Option<f64> {
    let t = ts.to_js_text();
    super::super::unfinished::store_ts_ms(&t).or_else(|| crate::cost::date::parse_ms(t.as_str()?))
}

impl Pair {
    /// The delta of a clean pair, whose both sides carry a cost.
    #[must_use]
    pub fn delta(&self) -> Option<Delta> {
        if self.status != "clean" {
            return None;
        }
        let (f, t) = (self.from.cost?, self.to.cost?);
        let mut by = [0.0; 9];
        for (i, slot) in by.iter_mut().enumerate().take(6) {
            *slot = t.get(i).copied().unwrap_or(0.0) - f.get(i).copied().unwrap_or(0.0);
        }
        by[6] = self.to.lens_agents - self.from.lens_agents;
        by[7] = self.to.candidates - self.from.candidates;
        by[8] = self.to.findings - self.from.findings;
        let ratio = super::super::plan::js_round(t[0] / f[0] * 100.0) / 100.0;
        let minutes = ms(&self.to.ts)
            .zip(ms(&self.from.ts))
            .map(|(b, a)| super::super::plan::js_round((b - a) / 60000.0));
        Some(Delta { by, ratio, minutes })
    }
}
