//! Whether a run an earlier binary started can go on under this one. Before 0.59.0 a metrics lens
//! and its verifier read the code graph's numbers over its MCP tools; since, the binary reads them
//! when the run starts and hands them over in the prompt. A state whose plan runs a metrics lens
//! yet holds no numbers is such an earlier run — this binary plans one only on numbers it read
//! ([`super::ready`]) —, and resumed it would refute every metric finding for want of rows and
//! hand its stored tasks, which ask for the graph's tools, to an agent that has none.

use crate::profile::Profile;
use crate::state::RunState;

/// Whether `run`, of `profiles` in its tracks' order, predates the metrics table.
#[must_use]
pub fn predates_table(run: &RunState, profiles: &[Profile]) -> bool {
    if !run.context.consumers.metrics.is_empty() {
        return false;
    }
    let planned = run.tracks.iter().zip(profiles).any(|(t, p)| {
        t.plan
            .as_ref()
            .is_some_and(|plan| plan.lenses.iter().any(|l| p.metrics_only(l)))
    });
    let admitted = run.critic.lenses.iter().any(|pl| {
        pl.split_once(':').is_some_and(|(profile, lens)| {
            profiles
                .iter()
                .any(|p| p.id == profile && p.metrics_only(lens))
        })
    });
    planned || admitted
}
