//! craft:review's light runs beside its full ones (realm @nick/craft, node #295), each chain — the
//! JS engine's and the CLI's — its own population: the agents, wall-clock minutes and confirmed
//! findings of a run, each over the runs whose record carries it. A record without `depth` counts
//! as full.

use crate::js::{Js, Obj};

/// One population's sums, each with its own denominator.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Population {
    pub runs: u64,
    pub agents: f64,
    pub agent_runs: u64,
    pub minutes: f64,
    pub minute_runs: u64,
    pub confirmed: f64,
    pub confirmed_runs: u64,
}

/// The review runs by chain, `[js, cli]`, then by depth, `[light, full]`.
pub type Depth = [[Population; 2]; 2];

/// Whether the run ran the light plan.
#[must_use]
pub fn is_light(r: &Obj) -> bool {
    r.text_units("depth") == "light"
}

/// Whether the run is craft:review's, of either chain (`isReviewRun`).
#[must_use]
pub fn is_review(r: &Obj) -> bool {
    let name = r.text_units("name");
    name == "review" || name == "cli-review"
}

fn add_to(sum: &mut f64, runs: &mut u64, v: Option<f64>) {
    if let Some(v) = v {
        *sum += v;
        *runs += 1;
    }
}

/// Adds one record when it is a review run.
pub fn add(depth: &mut Depth, r: &Obj) {
    if !is_review(r) {
        return;
    }
    let chain = usize::from(super::is_cli(r));
    let at = usize::from(!is_light(r));
    let Some(p) = depth.get_mut(chain).and_then(|c| c.get_mut(at)) else {
        return;
    };
    p.runs += 1;
    let stat = |o: Option<&Obj>, k: &str| o.and_then(|o| o.get(k)).and_then(Js::as_num);
    let stats = r.get("runtimeStats").and_then(Js::as_obj);
    add_to(&mut p.agents, &mut p.agent_runs, stat(stats, "agents"));
    add_to(
        &mut p.minutes,
        &mut p.minute_runs,
        stat(stats, "wallClockMinutes"),
    );
    let ver = r.get("verification").and_then(Js::as_obj);
    add_to(
        &mut p.confirmed,
        &mut p.confirmed_runs,
        stat(ver, "confirmed"),
    );
}

impl Population {
    /// Each average to one place, `None` when no run carried it: agents, minutes, confirmed.
    #[must_use]
    pub fn per_run(&self) -> [Option<f64>; 3] {
        let per = |sum: f64, n: u64| (n > 0).then(|| super::develop::tenths(sum, n));
        [
            per(self.agents, self.agent_runs),
            per(self.minutes, self.minute_runs),
            per(self.confirmed, self.confirmed_runs),
        ]
    }
}
