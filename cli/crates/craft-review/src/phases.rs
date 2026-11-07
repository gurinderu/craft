//! How a run moves on once no task of its phase is pending, as `reviewProfile` in
//! `lib/review-profile.mjs` orders it for each profile: each profile's scout plans its lenses; the
//! lens rounds run until each profile's last round adds nothing new or its plan's rounds are spent;
//! the one pool goes through the floor, the roll-up and the dedup; the verifiers judge it; the
//! verdicts make one report. The profiles of a mixed diff share each phase (realm @nick/craft,
//! node #421): one dedup and one verification over all their findings, one verdict.

use std::path::Path;

use serde_json::Value;

use crate::Error;
use crate::chain;
use crate::content;
use crate::dedup;
use crate::plan::{self, PlanInput};
use crate::profile::Profile;
use crate::prompts;
use crate::report;
use crate::rereview;
use crate::rounds;
use crate::state::{self, Phase, RunState, Task, TaskKind, TaskState};
use crate::step::StepError;
use crate::verify;

/// The answer of the phase's single task (the dedup), when it gave a valid one.
fn only_answer(run: &RunState) -> Option<Value> {
    run.tasks
        .first()
        .filter(|t| t.state == TaskState::Answered)
        .and_then(|t| t.answer.clone())
}

fn why_failed(task: Option<&Task>) -> String {
    task.and_then(|t| t.error.clone())
        .unwrap_or_else(|| "no answer".into())
}

/// The profiles taking part in the run, in its tracks' order.
fn profiles_of(run: &RunState) -> Result<Vec<Profile>, Error> {
    run.tracks
        .iter()
        .map(|t| Profile::load(&t.profile).map_err(Error::from))
        .collect()
}

/// Moves the run on once no task is pending.
///
/// # Errors
/// When a prompt cannot be rendered or the report written.
pub(crate) fn advance(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    if run.tasks.iter().any(|t| t.state == TaskState::Pending) {
        return Ok(());
    }
    let profiles = profiles_of(run)?;
    match run.phase {
        Phase::Scout => {
            let judged = rereview::judge(&mut run.chain, &run.tasks);
            run.notes.extend(judged);
            plan_tracks(run, &profiles);
            next_round(dir, run, &profiles)
        }
        Phase::Lenses => {
            let added = run.rounds.absorb(&run.tasks);
            for t in run.tracks.iter_mut().filter(|t| t.live()) {
                t.rounds += 1;
                t.dry = added.get(&t.profile).copied().unwrap_or(0) == 0;
            }
            next_round(dir, run, &profiles)
        }
        Phase::Dedup => {
            dedup_answered(run);
            start_verify(dir, run)
        }
        Phase::Verify => {
            // A split or thinned deciding pair buys the rest of its panel before anything settles.
            let more = verify::escalation(run)?;
            if !more.is_empty() {
                run.tasks.extend(more);
                return Ok(());
            }
            verify::settle_run(run);
            finish(dir, run)
        }
        Phase::Done => Ok(()),
    }
}

/// Plans each track from its scout's answer, the conservative fallback where it gave none.
fn plan_tracks(run: &mut RunState, profiles: &[Profile]) {
    for (track, p) in run.tracks.iter_mut().zip(profiles) {
        let task = run
            .tasks
            .iter()
            .find(|t| matches!(&t.kind, TaskKind::Scout { profile } if *profile == track.profile));
        let scout = task
            .filter(|t| t.state == TaskState::Answered)
            .and_then(|t| t.answer.as_ref());
        if scout.is_none() {
            run.not_run.push(format!(
                "{} scout classification — the plan is the conservative fallback (all lenses, 3-vote, 2 rounds), not a scouted one ({})",
                p.id,
                why_failed(task)
            ));
        }
        track.plan = Some(plan::plan(PlanInput {
            profile: p,
            scout,
            changed_files: &run.diff.files,
            spec: &run.context.spec,
            light: run.light,
        }));
    }
}

/// Hands out the next lens round, of every track still live; after the last, ends the rounds.
fn next_round(dir: &Path, run: &mut RunState, profiles: &[Profile]) -> Result<(), Error> {
    if !run.tracks.iter().any(state::Track::live) {
        return end_rounds(dir, run, profiles);
    }
    run.rounds.round += 1;
    let mut tasks = Vec::new();
    for (track, p) in run.tracks.iter().zip(profiles).filter(|(t, _)| t.live()) {
        let plan = track.plan.as_ref().ok_or(StepError::NoPlan)?;
        tasks.extend(rounds::tasks(
            &run.context,
            p,
            plan,
            &track.files,
            &run.rounds,
        )?);
    }
    run.tasks = tasks;
    run.phase = Phase::Lenses;
    Ok(())
}

/// After the last round: the lenses that never returned, then the pool to the dedup.
fn end_rounds(dir: &Path, run: &mut RunState, profiles: &[Profile]) -> Result<(), Error> {
    for p in profiles {
        let holes = run.rounds.holes(&p.id);
        if !holes.is_empty() {
            run.not_run.push(format!(
                "{} lenses that never returned — {}",
                p.id,
                holes.join(" · ")
            ));
        }
    }
    if run.rounds.pool.is_empty() {
        return finish(dir, run);
    }
    run.findings = dedup::prepare(&run.rounds.pool, profiles);
    let Some(first) = profiles.first().filter(|_| run.findings.len() >= 2) else {
        return start_verify(dir, run);
    };
    let ids: Vec<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
    run.tasks = vec![Task::new(
        format!("dedup-{}", ids.join("-")),
        format!("dedup:{}", ids.join("-")),
        prompts::dedup_prompt(&run.context, &run.findings)?,
        first.dedup_model,
        content::schema("dedup")?,
        TaskKind::Dedup,
    )];
    run.phase = Phase::Dedup;
    Ok(())
}

/// Merges the pool by the dedup's answer and the same-spot groups.
fn dedup_answered(run: &mut RunState) {
    let answer = only_answer(run);
    if answer.is_none() {
        run.notes.push(format!(
            "the dedup pass gave no valid answer ({}): only same-spot duplicates were merged",
            why_failed(run.tasks.first())
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
}

/// Hands the pool to its verifiers, or ends the run when none is to be spent.
fn start_verify(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    run.notes.extend(verify::skipped_note(run));
    run.tasks = verify::tasks(run)?;
    if run.tasks.is_empty() {
        verify::settle_run(run);
        return finish(dir, run);
    }
    run.phase = Phase::Verify;
    Ok(())
}

/// Files the run's round record, which a later run of its branch builds on; a run on no branch
/// files none.
fn file_round(dir: &Path, run: &RunState) -> Result<(), Error> {
    let Some(branch) = &run.chain.branch else {
        return Ok(());
    };
    let c = &run.chain;
    let record = chain::record(&c.repo, branch, &run.diff.head, c.round, c.ledger.clone());
    chain::file_record(dir, &record).map_err(|source| {
        let path = chain::record_path(dir);
        StepError::NoReport { path, source }.into()
    })
}

/// Ends the run: its verdict, and the report written beside the state.
///
/// # Errors
/// When the report cannot be written.
pub(crate) fn finish(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    let absorbed = rereview::absorb(&mut run.chain, &mut run.settled);
    run.notes.extend(absorbed);
    run.chain.ledger = rereview::ledger(&run.chain, &run.settled);
    file_round(dir, run)?;
    let verdict = report::verdict(run);
    let path = state::report_path(dir);
    std::fs::write(&path, report::markdown(run, &verdict))
        .map_err(|source| StepError::NoReport { path, source })?;
    run.verdict = Some(verdict);
    run.phase = Phase::Done;
    Ok(())
}
