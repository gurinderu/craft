//! How the craft:develop cycles ended (realm @nick/craft, nodes #263, #278, #281): converged,
//! capped at the round limit or stopped without a verdict, light or full, their rounds, the open
//! Medium+ left after each round and what the full reviews after convergence found. Each cycle is
//! read as `craft runs develop-cycle` files it ([`crate::develop::cycle_record`]); one it would
//! refuse is counted unreadable, never guessed at.

use crate::js::{Js, Obj};

/// The develop sums over the cycles.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Develop {
    pub cycles: u64,
    pub unreadable: u64,
    pub converged: u64,
    pub capped: u64,
    pub no_verdict: u64,
    pub light: u64,
    pub full: u64,
    pub rounds: u64,
    pub converged_rounds: u64,
    /// Per round number from 1: the cycles that reached it, and their open Medium+ summed.
    pub by_round: Vec<(u64, f64)>,
    pub full_reviews: u64,
    pub full_reopened: u64,
    pub full_no_verdict: u64,
}

#[expect(
    clippy::cast_precision_loss,
    reason = "a round count is far below 2^52"
)]
fn float(n: u64) -> f64 {
    n as f64
}

impl Develop {
    /// The rounds of a cycle, and of a converged one, to one place.
    #[must_use]
    pub fn rounds_per_cycle(&self) -> (f64, f64) {
        (
            tenths(float(self.rounds), self.cycles),
            tenths(float(self.converged_rounds), self.converged),
        )
    }

    /// Adds one develop record.
    pub fn add(&mut self, r: &Obj) {
        let read = r
            .get("develop")
            .and_then(Js::as_obj)
            .and_then(|c| crate::develop::cycle_record(c).ok());
        let Some(cycle) = read
            .as_ref()
            .and_then(|c| c.get("develop"))
            .and_then(Js::as_obj)
        else {
            self.unreadable += 1;
            return;
        };
        let list = |k: &str| cycle.get(k).and_then(Js::as_arr).unwrap_or(&[]).to_vec();
        let (rounds, full) = (list("rounds"), list("fullReviews"));
        let n = rounds.len() as u64;
        self.cycles += 1;
        match cycle.text_units("outcome").as_str() {
            Some("converged") => {
                self.converged += 1;
                self.converged_rounds += n;
            }
            Some("capped") => self.capped += 1,
            _ => self.no_verdict += 1,
        }
        if cycle.text_units("mode") == "full" {
            self.full += 1;
        } else {
            self.light += 1;
        }
        self.rounds += n;
        for (i, round) in rounds.iter().enumerate() {
            if self.by_round.len() <= i {
                self.by_round.push((0, 0.0));
            }
            let plus = medium_plus(round).unwrap_or(0.0);
            if let Some(at) = self.by_round.get_mut(i) {
                *at = (at.0 + 1, at.1 + plus);
            }
        }
        for f in &full {
            self.full_reviews += 1;
            match medium_plus(f) {
                None => self.full_no_verdict += 1,
                Some(p) if p > 0.0 => self.full_reopened += 1,
                Some(_) => {}
            }
        }
    }
}

/// A round's or full review's open Medium+, `None` when it had no verdict.
fn medium_plus(v: &Js) -> Option<f64> {
    v.as_obj()
        .and_then(|o| o.get("mediumPlus"))
        .and_then(Js::as_num)
}

/// `Math.round(a / b * 10) / 10`, `0` over nothing.
#[must_use]
pub fn tenths(a: f64, b: u64) -> f64 {
    #[expect(
        clippy::cast_precision_loss,
        reason = "a cycle count is far below 2^52"
    )]
    let b = b as f64;
    if b == 0.0 {
        0.0
    } else {
        super::plan::js_round(a / b * 10.0) / 10.0
    }
}

#[cfg(test)]
mod tests;
