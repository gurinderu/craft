//! A workflow's runs beside their verdicts, as the retired `analyze-runs.mjs` summed them before the retro
//! carried them: what its refute rate is an average over, the panels that half-died, and over the
//! runs that ran the full plan (a light run is its own population, [`super::depth`]) the token
//! pool and real cost ([`super::plan`]) and the surface gate's saving (realm @nick/craft, nodes
//! #102, #103, #107). What a record does not carry is counted apart, never as zero.

use std::collections::BTreeMap;

use crate::js::{Js, Obj, Utf16Error};

use super::plan::Plan;

/// One workflow's sums beyond its [`crate::tally::Tally`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Flow {
    /// Runs whose refute rate was over the judged candidates only (`verification.unverified`).
    pub refute_tracked: u64,
    /// Runs whose refute rate predates the unverified tier.
    pub refute_legacy: u64,
    pub thinned: f64,
    pub thinned_runs: u64,
    /// Runs whose record carried `verification.thinned`.
    pub thinned_measured: u64,
    pub plan: Plan,
    pub gate: Gate,
}

/// The surface gate over a workflow's full-plan runs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Gate {
    /// Runs with no `surfaceGate` record.
    pub pre_gate: u64,
    pub gate_runs: u64,
    /// Gate-present runs excluded: the gate failed before any lens ran.
    pub failed_runs: u64,
    pub saved_runs: u64,
    pub saved_passes: u64,
    pub saved_by_lens: BTreeMap<String, u64>,
    /// Over the runs that carry `dispatched` only, the share's two sides.
    pub dispatched_passes: u64,
    pub share_saved_passes: u64,
    pub missing_dispatched_runs: u64,
}

/// What a refute average is over: `strict`, `legacy`, `mixed`, or `None` over no rate at all.
#[must_use]
pub fn basis(tracked: u64, legacy: u64) -> Option<&'static str> {
    match (tracked > 0, legacy > 0) {
        (false, false) => None,
        (true, true) => Some("mixed"),
        (true, false) => Some("strict"),
        (false, true) => Some("legacy"),
    }
}

impl Flow {
    /// What the workflow's average refute rate is over.
    #[must_use]
    pub fn refute_basis(&self) -> Option<&'static str> {
        basis(self.refute_tracked, self.refute_legacy)
    }

    /// Adds the run's verification and, for a full-plan run, its surface gate.
    /// # Errors
    /// When a lens the gate dropped cannot be represented as Unicode.
    pub fn add(&mut self, r: &Obj, full_plan: bool) -> Result<(), Utf16Error> {
        if let Some(ver) = r.get("verification").and_then(Js::as_obj) {
            if ver.get("refuteRate").and_then(Js::as_num).is_some() {
                if ver.get("unverified").and_then(Js::as_num).is_some() {
                    self.refute_tracked += 1;
                } else {
                    self.refute_legacy += 1;
                }
            }
            if let Some(t) = ver.get("thinned").and_then(Js::as_num) {
                self.thinned_measured += 1;
                if t > 0.0 {
                    self.thinned += t;
                    self.thinned_runs += 1;
                }
            }
        }
        if full_plan {
            self.gate.add(r)?;
        }
        Ok(())
    }
}

impl Gate {
    /// The share of the gateable passes the gate saved, in percent to two places.
    #[must_use]
    pub fn share(&self) -> Option<f64> {
        let all = self.share_saved_passes + self.dispatched_passes;
        #[expect(clippy::cast_precision_loss, reason = "a pass count is far below 2^52")]
        let share = (all > 0)
            .then(|| crate::tally::round2(self.share_saved_passes as f64 / all as f64 * 100.0));
        share
    }

    fn add(&mut self, r: &Obj) -> Result<(), Utf16Error> {
        let empty = Obj::new();
        let sg = match r.get("surfaceGate") {
            Some(Js::Obj(o)) => o,
            Some(Js::Arr(_)) => &empty,
            _ => {
                self.pre_gate += 1;
                return Ok(());
            }
        };
        self.gate_runs += 1;
        let dropped = match sg.get("dropped") {
            Some(Js::Arr(a)) => a.iter().map(Js::to_js_string).collect::<Result<_, _>>()?,
            _ => Vec::new(),
        };
        let dispatched = sg.get("dispatched").and_then(Js::as_arr);
        let failed = r
            .get("gate")
            .and_then(Js::as_obj)
            .is_some_and(|g| g.text_units("status") == "fail")
            && dispatched.is_some_and(<[Js]>::is_empty)
            && sg.get("lensesRan") != Some(&Js::Bool(true));
        if failed {
            self.failed_runs += 1;
            return Ok(());
        }
        let n = dropped.len() as u64;
        self.saved_runs += u64::from(n > 0);
        self.saved_passes += n;
        for lens in dropped {
            *self.saved_by_lens.entry(lens).or_default() += 1;
        }
        match dispatched {
            Some(d) => {
                self.share_saved_passes += n;
                self.dispatched_passes += d.len() as u64;
            }
            None => self.missing_dispatched_runs += 1,
        }
        Ok(())
    }
}
