//! A workflow's surface gate as JSON.

use craft_store::js::{Js, Obj};
use craft_store::retro::Gate;

use super::super::{count, ranked};
use super::or_null;

pub(super) fn gate_json(g: &Gate) -> Obj {
    let mut by = Obj::new();
    for (lens, n) in ranked(&g.saved_by_lens) {
        by.set(lens, count(*n));
    }
    Obj::new()
        .with("preGate", count(g.pre_gate))
        .with("gateRuns", count(g.gate_runs))
        .with("failedRuns", count(g.failed_runs))
        .with("savedRuns", count(g.saved_runs))
        .with("savedPasses", count(g.saved_passes))
        .with("savedByLens", Js::Obj(by))
        .with("dispatchedPasses", count(g.dispatched_passes))
        .with("shareSavedPasses", count(g.share_saved_passes))
        .with("missingDispatchedRuns", count(g.missing_dispatched_runs))
        .with("share", or_null(g.share()))
}
