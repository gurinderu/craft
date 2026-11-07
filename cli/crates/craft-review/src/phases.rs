//! How a run moves on once no task of its phase is pending, as `reviewProfile` in
//! `lib/review-profile.mjs` orders it: the scout's answer plans the lenses; the lens rounds run
//! until one adds nothing new or the plan's rounds are spent; the pool goes through the floor, the
//! roll-up and the dedup; the verifiers judge it; the verdicts make the report.

use std::path::Path;

use serde_json::Value;

use crate::Error;
use crate::content;
use crate::dedup;
use crate::plan::{self, Plan, PlanInput};
use crate::profile::Profile;
use crate::prompts;
use crate::report;
use crate::rounds;
use crate::state::{self, Phase, RunState, Task, TaskKind, TaskState};
use crate::step::StepError;
use crate::verify;

/// The answer of the phase's single task (the scout, the dedup), when it gave a valid one.
fn only_answer(run: &RunState) -> Option<Value> {
    run.tasks
        .first()
        .filter(|t| t.state == TaskState::Answered)
        .and_then(|t| t.answer.clone())
}

fn why_failed(run: &RunState) -> String {
    run.tasks
        .first()
        .and_then(|t| t.error.clone())
        .unwrap_or_else(|| "no answer".into())
}

/// Moves the run on once no task is pending.
///
/// # Errors
/// When a prompt cannot be rendered or the report written.
pub(crate) fn advance(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    if run.tasks.iter().any(|t| t.state == TaskState::Pending) {
        return Ok(());
    }
    let profile = Profile::rust()?;
    match run.phase {
        Phase::Scout => {
            let scout = only_answer(run);
            if scout.is_none() {
                run.not_run.push(format!(
                    "{} scout classification — the plan is the conservative fallback (all lenses, 3-vote, 2 rounds), not a scouted one ({})",
                    profile.id,
                    why_failed(run)
                ));
            }
            let planned = plan::plan(PlanInput {
                profile: &profile,
                scout: scout.as_ref(),
                changed_files: &run.diff.files,
                spec: &run.context.spec,
                light: run.light,
            });
            run.plan = Some(planned);
            next_round(run, &profile)
        }
        Phase::Lenses => {
            let dry = run.rounds.absorb(&run.tasks);
            let max = run.plan.as_ref().map_or(1, |p| p.max_rounds);
            if !dry && run.rounds.round < max {
                return next_round(run, &profile);
            }
            end_rounds(dir, run, &profile)
        }
        Phase::Dedup => {
            let answer = only_answer(run);
            if answer.is_none() {
                run.notes.push(format!(
                    "the dedup pass gave no valid answer ({}): only same-spot duplicates were merged",
                    why_failed(run)
                ));
            }
            let (merged, folded) = dedup::merge(&run.findings, answer.as_ref());
            if folded > 0 {
                run.notes.push(format!(
                    "dedup before verification: {} → {} ({folded} cross-lens duplicate(s) merged)",
                    run.findings.len(),
                    merged.len()
                ));
            }
            run.findings = merged;
            start_verify(dir, run, &profile)
        }
        Phase::Verify => {
            // A split or thinned deciding pair buys the rest of its panel before anything settles.
            let more = verify::escalation(run)?;
            if !more.is_empty() {
                run.tasks.extend(more);
                return Ok(());
            }
            verify::settle_run(run, &profile.id);
            finish(dir, run)
        }
        Phase::Done => Ok(()),
    }
}

fn plan_of(run: &RunState) -> Result<&Plan, StepError> {
    run.plan.as_ref().ok_or(StepError::NoPlan)
}

/// Hands out the next lens round.
fn next_round(run: &mut RunState, profile: &Profile) -> Result<(), Error> {
    run.rounds.round += 1;
    run.tasks = rounds::tasks(&run.context, profile, plan_of(run)?, &run.rounds)?;
    run.phase = Phase::Lenses;
    Ok(())
}

/// After the last round: the lenses that never returned, then the pool to the dedup.
fn end_rounds(dir: &Path, run: &mut RunState, profile: &Profile) -> Result<(), Error> {
    let holes = run.rounds.holes();
    if !holes.is_empty() {
        run.not_run.push(format!(
            "{} lenses that never returned — {}",
            profile.id,
            holes.join(" · ")
        ));
    }
    if run.rounds.pool.is_empty() {
        return finish(dir, run);
    }
    run.findings = dedup::prepare(&run.rounds.pool, profile);
    if run.findings.len() < 2 {
        return start_verify(dir, run, profile);
    }
    run.tasks = vec![Task::new(
        format!("dedup-{}", profile.id),
        format!("dedup:{}", profile.id),
        prompts::dedup_prompt(&run.context, &run.findings)?,
        profile.dedup_model,
        content::schema("dedup")?,
        TaskKind::Dedup,
    )];
    run.phase = Phase::Dedup;
    Ok(())
}

/// Hands the pool to its verifiers, or ends the run when none is to be spent.
fn start_verify(dir: &Path, run: &mut RunState, profile: &Profile) -> Result<(), Error> {
    run.notes.extend(verify::skipped_note(run));
    run.tasks = verify::tasks(run)?;
    if run.tasks.is_empty() {
        verify::settle_run(run, &profile.id);
        return finish(dir, run);
    }
    run.phase = Phase::Verify;
    Ok(())
}

/// Ends the run: its verdict, and the report written beside the state.
///
/// # Errors
/// When the report cannot be written.
pub(crate) fn finish(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    let verdict = report::verdict(run);
    let path = state::report_path(dir);
    std::fs::write(&path, report::markdown(run, &verdict))
        .map_err(|source| StepError::NoReport { path, source })?;
    run.verdict = Some(verdict);
    run.phase = Phase::Done;
    Ok(())
}
