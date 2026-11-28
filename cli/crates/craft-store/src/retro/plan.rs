//! A workflow's full-plan runs priced: the real cost by token part, over the runs whose cost is
//! usable ([`crate::cost::problem`]), the others counted apart by why; and the indicative token
//! pool (`outputTokens`, the turn's shared output spend), only for a run marked `turn-delta`
//! whose cost is not usable, split by its round: first-pass, re-review, or not recorded.

use std::collections::BTreeMap;

use crate::cost::problem::{self, Problem};
use crate::js::{Js, Obj};

/// The token parts a cost carries, in the order they are summed.
pub const PARTS: [&str; 4] = ["cacheRead", "cacheWrite", "input", "output"];

/// What pricing a run needs from its record beside its cost.
#[derive(Debug, Clone, PartialEq)]
pub struct Input {
    tokens: Option<f64>,
    round: Option<f64>,
    turn_delta: bool,
}

impl Input {
    #[must_use]
    pub fn of(r: &Obj) -> Self {
        Self {
            tokens: r.get("outputTokens").and_then(Js::as_num),
            round: r.get("round").and_then(Js::as_num),
            turn_delta: r.text_units("outputTokensScope") == "turn-delta",
        }
    }
}

/// One pool: its tokens summed over its runs.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Pool {
    pub runs: u64,
    pub tokens: f64,
}

/// A workflow's full-plan runs, priced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Plan {
    /// First-pass (round ≤ 1), re-review (round > 1), round not recorded.
    pub pools: [Pool; 3],
    pub priced: u64,
    /// [`PARTS`] summed over the priced runs.
    pub parts: [f64; 4],
    pub total: f64,
    /// The runs with a cost that is not usable, by why; a run never enriched is not counted.
    pub apart: BTreeMap<Problem, u64>,
}

/// `Math.round`.
#[must_use]
pub fn js_round(n: f64) -> f64 {
    let f = n.floor();
    if n - f >= 0.5 { f + 1.0 } else { f }
}

/// `sum / n` rounded to a whole number, `None` over no run.
#[must_use]
pub fn avg(sum: f64, n: u64) -> Option<f64> {
    #[expect(clippy::cast_precision_loss, reason = "a run count is far below 2^52")]
    let n = (n > 0).then_some(n as f64);
    n.map(|n| js_round(sum / n))
}

impl Plan {
    /// Adds one full-plan run priced by `cost`.
    pub fn add(&mut self, input: &Input, cost: Option<&Js>) {
        let why = problem::problem(cost);
        if input.turn_delta
            && why.is_some()
            && let Some(tokens) = input.tokens
        {
            let at = match input.round {
                Some(r) if r > 1.0 => 1,
                Some(_) => 0,
                None => 2,
            };
            if let Some(pool) = self.pools.get_mut(at) {
                pool.runs += 1;
                pool.tokens += tokens;
            }
        }
        match (why, cost.and_then(Js::as_obj)) {
            (None, Some(c)) => {
                self.priced += 1;
                for (sum, k) in self.parts.iter_mut().zip(PARTS) {
                    *sum += c
                        .get(k)
                        .and_then(Js::as_num)
                        .filter(|n| n.is_finite())
                        .unwrap_or(0.0);
                }
                self.total += problem::total(c);
            }
            (Some(Problem::Missing), _) | (None, None) => {}
            (Some(p), _) => *self.apart.entry(p).or_default() += 1,
        }
    }

    /// Each [`PARTS`] per priced run, then the total, rounded.
    #[must_use]
    pub fn per_run(&self) -> Option<([f64; 4], f64)> {
        let total = avg(self.total, self.priced)?;
        let mut parts = [0.0; 4];
        for (out, sum) in parts.iter_mut().zip(self.parts) {
            *out = avg(sum, self.priced).unwrap_or(0.0);
        }
        Some((parts, total))
    }
}

#[cfg(test)]
mod tests;
