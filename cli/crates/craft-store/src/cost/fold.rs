//! The cost of a run stopped and resumed, as its standing record carries it once its stopped parts
//! fold into it (`summedCost` in `integrations/shared/run-parts.mjs`; both held to
//! `content/parity/cost-problem-cases.json`, realm @nick/craft, node #658): every Workflow run's
//! share of usable cost summed once — by the cost's `source` and slice, a repeated share the
//! latest part's — and how many shares carry no usable cost as `partsUnmeasured`.

use super::problem::{self, Problem};
use crate::js::{Js, JsString, Obj};

const COUNTS: [&str; 5] = ["output", "input", "cacheRead", "cacheWrite", "agents"];

/// One part of a run: its time and its cost.
pub type Part = (JsString, Option<Js>);

/// The share of its Workflow run a cost is, `None` when it names no run (a share of its own).
fn share(cost: Option<&Js>) -> Option<String> {
    let c = cost?.as_obj()?;
    let source = c.get("source").and_then(Js::as_str)?;
    let index = c
        .get("slice")
        .filter(|s| problem::is_slice(s))
        .and_then(Js::as_obj)
        .and_then(|s| s.get("index"))
        .and_then(Js::as_num)
        .map(crate::js::number_text)
        .unwrap_or_default();
    Some(format!("{source}#{index}"))
}

/// Whether a cost is summed: usable, or a measured lower bound.
fn counted(cost: Option<&Js>) -> bool {
    problem::problem(cost).is_none_or(|p| p == Problem::Partial)
}

fn num(c: &Obj, k: &str) -> f64 {
    c.get(k)
        .and_then(Js::as_num)
        .filter(|n| !n.is_nan())
        .unwrap_or(0.0)
}

/// The cost `parts` — the standing part first, then the stopped parts folding into it — sum to.
#[must_use]
pub fn summed(parts: &[Part]) -> Option<Js> {
    let mut by_time: Vec<&Part> = parts.iter().collect();
    by_time.sort_by(|a, b| a.0.cmp(&b.0));
    let mut shares: Vec<(String, &Part)> = Vec::new();
    for (i, p) in by_time.into_iter().enumerate() {
        let key = share(p.1.as_ref()).unwrap_or_else(|| format!("#{i}"));
        match shares.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = p,
            None => shares.push((key, p)),
        }
    }
    let usable: Vec<&Obj> = shares
        .iter()
        .filter(|(_, p)| counted(p.1.as_ref()))
        .filter_map(|(_, p)| p.1.as_ref().and_then(Js::as_obj))
        .collect();
    let own = parts.first().and_then(|p| p.1.as_ref());
    let Some(first) = usable.first() else {
        return own.cloned();
    };
    let mut sum = own
        .filter(|c| counted(Some(c)))
        .and_then(Js::as_obj)
        .unwrap_or(first)
        .clone();
    for k in COUNTS {
        sum.set(k, Js::Num(usable.iter().map(|c| num(c, k)).sum()));
    }
    sum.set(
        "total",
        Js::Num(usable.iter().map(|c| problem::total(c)).sum()),
    );
    let skipped: f64 = usable.iter().map(|c| num(c, "skipped")).sum();
    if skipped == 0.0 {
        sum.remove("skipped");
    } else {
        sum.set("skipped", Js::Num(skipped));
    }
    let unmeasured = shares.len() - usable.len();
    if unmeasured > 0 {
        #[expect(clippy::cast_precision_loss, reason = "a part count is far below 2^52")]
        sum.set("partsUnmeasured", Js::Num(unmeasured as f64));
    }
    Some(Js::Obj(sum))
}
