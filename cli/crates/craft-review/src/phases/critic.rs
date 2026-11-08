//! The completeness critic's part of a run's end ([`crate::critic`]), as `criticPhase` places it
//! after verification: the critic asked, the lenses it admitted run, and what they found
//! deduplicated and verified as a pass of its own, its settled findings joined to the first pass's;
//! then the project's memory.

use std::path::Path;

use super::{settle_memory, to_dedup};
use crate::Error;
use crate::critic::{self, Stage};
use crate::profile::Profile;
use crate::state::{Phase, RunState};
use crate::verify;

/// Once a verification pass is in: the first asks the critic, the critic's own joins the first's.
///
/// # Errors
/// When a prompt cannot be rendered or the report written.
pub(super) fn verified(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    verify::settle_run(run);
    match run.critic.stage {
        Stage::Before => ask(dir, run),
        Stage::Verifying => {
            let mut all = std::mem::take(&mut run.critic.settled_before);
            all.append(&mut run.settled);
            run.settled = all;
            run.critic.stage = Stage::Done;
            settle_memory(dir, run)
        }
        Stage::Asked | Stage::Done => settle_memory(dir, run),
    }
}

/// The critics of the plans that call for one, or on to the memory when none does.
pub(super) fn ask(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    let profiles = super::profiles_of(run)?;
    let tasks = critic::tasks(run, &profiles)?;
    if tasks.is_empty() {
        run.critic.stage = Stage::Done;
        return settle_memory(dir, run);
    }
    run.critic.stage = Stage::Asked;
    run.tasks = tasks;
    run.phase = Phase::Critic;
    Ok(())
}

/// The lenses the critics admitted, or on to the memory when they admitted none.
pub(super) fn answered(dir: &Path, run: &mut RunState, profiles: &[Profile]) -> Result<(), Error> {
    let tasks = critic::followups(run, profiles)?;
    if tasks.is_empty() {
        run.critic.stage = Stage::Done;
        return settle_memory(dir, run);
    }
    run.tasks = tasks;
    run.phase = Phase::CriticLenses;
    Ok(())
}

/// What the admitted lenses found anew, deduplicated and verified as a pass of its own.
pub(super) fn lenses_back(
    dir: &Path,
    run: &mut RunState,
    profiles: &[Profile],
) -> Result<(), Error> {
    let fresh = critic::fresh(run);
    run.notes.push(format!(
        "critic follow-up: {} new finding(s) to verify",
        fresh.len()
    ));
    if fresh.is_empty() {
        run.critic.stage = Stage::Done;
        return settle_memory(dir, run);
    }
    run.critic.stage = Stage::Verifying;
    run.critic.settled_before = std::mem::take(&mut run.settled);
    to_dedup(dir, run, profiles, &fresh)
}
