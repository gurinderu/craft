//! A group of runs summed as the run-store report (`lib/analyze-runs.mjs`) sums a workflow's runs:
//! the verdicts in exclusive buckets, severity first then coverage (`tallyVerdict`); the findings by
//! severity; the verification's candidates, confirmed findings and refute rates; a triage run's
//! dispositions.

use crate::js::{Js, Obj};
use crate::record::SEVERITIES;

/// The dispositions a triage run counts.
pub const TRIAGE: [&str; 8] = [
    "gathered",
    "validated",
    "accept",
    "reject",
    "defer",
    "needs-decision",
    "conflict",
    "issues",
];

/// One group's sums.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tally {
    pub runs: u64,
    pub block: u64,
    pub warning: u64,
    pub approve: u64,
    /// Runs whose verdict is nothing but incomplete.
    pub incomplete: u64,
    /// Runs whose verdict carries a coverage marker, whatever its severity.
    pub partial_coverage: u64,
    pub findings: [f64; 5],
    pub candidates: f64,
    pub confirmed: f64,
    pub refute_sum: f64,
    pub refute_n: u64,
    pub triage: [f64; 8],
}

fn has(v: &str, words: &[&str]) -> bool {
    let v = v.to_lowercase();
    words.iter().any(|w| v.contains(w))
}

/// Whether a verdict carries a coverage marker (`isIncomplete`).
#[must_use]
pub fn is_incomplete(verdict: &str) -> bool {
    has(verdict, &["incomplete", "partial coverage"])
}

fn num(o: Option<&Obj>, k: &str) -> Option<f64> {
    o.and_then(|o| o.get(k)).and_then(Js::as_num)
}

/// `Number(v) || 0` for a count the store holds.
fn count(o: Option<&Obj>, k: &str) -> f64 {
    num(o, k).filter(|n| n.is_finite()).unwrap_or(0.0)
}

impl Tally {
    /// Adds one run's record.
    pub fn add(&mut self, r: &Obj) {
        self.runs += 1;
        let v = match r.get("verdict") {
            Some(v) if v.truthy() => v.to_js_string(),
            _ => String::new(),
        };
        let incomplete = is_incomplete(&v);
        self.partial_coverage += u64::from(incomplete);
        if has(&v, &["block", "at-risk", "ub-found"]) {
            self.block += 1;
        } else if has(&v, &["warning", "concerns"]) {
            self.warning += 1;
        } else if incomplete {
            self.incomplete += 1;
        } else if has(&v, &["approve", "healthy", "clean"]) {
            self.approve += 1;
        }
        let by = r
            .get("findings")
            .and_then(Js::as_obj)
            .and_then(|f| f.get("bySeverity"))
            .and_then(Js::as_obj);
        for (i, s) in SEVERITIES.iter().enumerate() {
            if let Some(n) = self.findings.get_mut(i) {
                *n += count(by, s);
            }
        }
        let ver = r.get("verification").and_then(Js::as_obj);
        if let Some(rate) = num(ver, "refuteRate") {
            self.refute_sum += rate;
            self.refute_n += 1;
        }
        self.candidates += num(ver, "candidates").unwrap_or(0.0);
        self.confirmed += num(ver, "confirmed").unwrap_or(0.0);
        let triage = r.get("triage").and_then(Js::as_obj);
        for (i, k) in TRIAGE.iter().enumerate() {
            if let Some(n) = self.triage.get_mut(i) {
                *n += count(triage, k);
            }
        }
    }

    /// The average refute rate to two places, `None` when no run gave one.
    #[must_use]
    pub fn avg_refute(&self) -> Option<f64> {
        #[expect(clippy::cast_precision_loss, reason = "a run count is far below 2^52")]
        let n = self.refute_n as f64;
        (self.refute_n > 0).then(|| round2(self.refute_sum / n))
    }

    /// The share of the verified candidates confirmed, `None` when none was verified.
    #[must_use]
    pub fn verified_share(&self) -> Option<f64> {
        (self.candidates > 0.0).then(|| round2(self.confirmed / self.candidates))
    }

    /// The findings counted, every severity.
    #[must_use]
    pub fn findings_total(&self) -> f64 {
        self.findings.iter().sum()
    }
}

/// `Math.round(n * 100) / 100`.
#[must_use]
pub fn round2(n: f64) -> f64 {
    let x = n * 100.0;
    let f = x.floor();
    (if x - f >= 0.5 { f + 1.0 } else { f }) / 100.0
}
