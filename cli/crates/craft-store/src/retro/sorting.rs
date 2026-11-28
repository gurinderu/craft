//! How the doubtful findings held back from a PR ended (realm @nick/craft, nodes #270, #281): per
//! run with `sorting`, the findings posted as defects at once and those held back as doubtful, and
//! of those the reviewer's later choice — posted as a defect, asked the author, not posted.

use crate::js::{Js, Obj};

/// The sorting sums over the runs that carry one.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Sorting {
    pub runs: u64,
    pub posted: f64,
    pub doubtful: f64,
    pub defect: u64,
    pub question: u64,
    pub dropped: u64,
}

/// A positive whole count, else 0.
fn count(o: &Obj, k: &str) -> f64 {
    o.get(k)
        .and_then(Js::as_num)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0)
        .unwrap_or(0.0)
}

impl Sorting {
    /// Adds one run's sorting, when it has one.
    pub fn add(&mut self, r: &Obj) {
        let Some(s) = r.get("sorting").and_then(Js::as_obj) else {
            return;
        };
        self.runs += 1;
        self.posted += count(s, "defect");
        self.doubtful += count(s, "doubtful");
        let choices: Vec<&Js> = match s.get("choices") {
            Some(Js::Obj(o)) => o.iter().map(|(_, v)| v).collect(),
            Some(Js::Arr(a)) => a.iter().collect(),
            _ => Vec::new(),
        };
        for c in choices.iter().filter_map(|c| c.as_obj()) {
            match c.get("choice").and_then(Js::as_str) {
                Some("defect") => self.defect += 1,
                Some("question") => self.question += 1,
                Some("dropped") => self.dropped += 1,
                _ => {}
            }
        }
    }

    /// The doubtful findings no choice has decided yet.
    #[must_use]
    pub fn undecided(&self) -> f64 {
        #[expect(
            clippy::cast_precision_loss,
            reason = "a choice count is far below 2^52"
        )]
        let decided = (self.defect + self.question + self.dropped) as f64;
        (self.doubtful - decided).max(0.0)
    }

    /// `n` as a whole percent of the doubtful, `None` when none was doubtful.
    #[must_use]
    pub fn percent(&self, n: u64) -> Option<f64> {
        #[expect(
            clippy::cast_precision_loss,
            reason = "a choice count is far below 2^52"
        )]
        let n = n as f64;
        (self.doubtful > 0.0).then(|| super::plan::js_round(n / self.doubtful * 100.0))
    }
}

#[cfg(test)]
mod tests;
