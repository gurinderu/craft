//! How a run moves on once no task of its phase is pending, as `reviewProfile` in
//! `lib/review-profile.mjs` orders it for each profile: each profile's scout plans its lenses; the
//! lens rounds run until each profile's last round adds nothing new or its plan's rounds are spent;
//! the one pool goes through the floor, the roll-up and the dedup; the verifiers judge it; the
//! project's memory sets aside what it answers, its match judge and then its rule judge asked when
//! a pair needs them; the verdicts make one report. On a re-review a red team attacks each
//! resolved Critical or High prior before the lenses run. The profiles of a mixed diff share each
//! phase (realm @nick/craft, node #421): one dedup and one verification over all their findings,
//! one verdict.

use std::path::Path;

use serde_json::Value;

use crate::Error;
use crate::agent::Model;
use crate::chain;
use crate::complexity;
use crate::content;
use crate::dedup;
use crate::extra;
use crate::plan::{self, PlanInput};
use crate::profile::Profile;
use crate::prompts;
use crate::report;
use crate::rereview;
use crate::rounds;
use crate::state::{self, Phase, RunState, Task, TaskKind, TaskState};
use crate::step::StepError;
use crate::units;
use crate::verify;

mod critic;
mod memory;

pub(crate) use memory::settle as settle_memory;

/// The answer of the phase's single task (the dedup, a memory judge), when it gave a valid one.
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
            run.memory.take_recall(&run.tasks);
            let memory = &run.memory;
            let released = rereview::hold_deferrals(&mut run.chain, &|row| memory.holds(row));
            run.notes.extend(released);
            // A run that ended before its scouts (a red gate) plans no lens; its priors are
            // still adjudicated.
            if run.exit.is_none() {
                plan_tracks(run, &profiles);
            }
            // Built before the adjudicators' answers move their priors, on the first plan's lens
            // model, as the engine's `adjudModel`.
            let model = lens_model(run, &profiles);
            let attacks = rereview::attack_tasks(&run.context, &run.chain, &run.tasks, model)?;
            let judged = rereview::judge(&mut run.chain, &run.tasks);
            run.notes.extend(judged);
            if attacks.is_empty() {
                return next_round(dir, run, &profiles);
            }
            run.tasks = attacks;
            run.phase = Phase::RedTeam;
            Ok(())
        }
        Phase::RedTeam => {
            let notes = rereview::take_attacks(&mut run.chain, &run.tasks);
            run.notes.extend(notes);
            next_round(dir, run, &profiles)
        }
        Phase::Lenses => {
            run.telemetry.dispatched(&run.tasks);
            let sifted = complexity::sift(&mut run.tasks, &profiles);
            run.notes.extend(sifted);
            let first = run.tracks.first().map(|t| t.profile.clone());
            extra::take(&mut run.extra, &run.tasks, first.as_deref().unwrap_or(""));
            units::keep_questions(run);
            let added = run.rounds.absorb(&run.tasks);
            for t in run.tracks.iter_mut().filter(|t| t.live()) {
                t.rounds += 1;
                t.dry = added.get(&t.profile).copied().unwrap_or(0) == 0;
            }
            next_round(dir, run, &profiles)
        }
        Phase::Seam => {
            run.telemetry.dispatched(&run.tasks);
            units::seam_answered(run);
            to_pool(dir, run, &profiles)
        }
        Phase::Dedup => {
            dedup_answered(run);
            start_verify(dir, run)
        }
        Phase::Verify => {
            // A split or thinned deciding pair buys the rest of its panel before anything settles.
            let mut more = verify::escalation(run)?;
            crate::critic::relabel(run, &mut more);
            if !more.is_empty() {
                run.tasks.extend(more);
                return Ok(());
            }
            critic::verified(dir, run)
        }
        Phase::Critic => critic::answered(dir, run, &profiles),
        Phase::CriticLenses => {
            run.telemetry.dispatched(&run.tasks);
            critic::lenses_back(dir, run, &profiles)
        }
        Phase::Match => memory::matched(dir, run),
        Phase::Rules => memory::ruled(dir, run),
        Phase::Done => Ok(()),
    }
}

/// The lens model of the run's first plan (`results[0].plan.lensModel`), Opus before any.
fn lens_model(run: &RunState, profiles: &[Profile]) -> Model {
    run.tracks
        .iter()
        .zip(profiles)
        .find_map(|(t, p)| Some(t.plan.as_ref()?.lens_model(p)))
        .unwrap_or(Model::Opus)
}

/// Plans each track from its scout's answer, the conservative fallback where it gave none; the
/// metrics-or-nothing lenses only when the warm-up found an index.
fn plan_tracks(run: &mut RunState, profiles: &[Profile]) {
    let index = complexity::indexed(&run.tasks);
    let metrics = index.as_ref().is_some_and(|(found, _)| *found);
    run.notes.extend(index.and_then(|(_, note)| note));
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
            strict: run.context.strict,
            metrics,
        }));
    }
}

/// Hands out the next lens round, of every track still live; after the last, ends the rounds.
fn next_round(dir: &Path, run: &mut RunState, profiles: &[Profile]) -> Result<(), Error> {
    if !run.tracks.iter().any(state::Track::live) {
        return end_rounds(dir, run, profiles);
    }
    run.rounds.round += 1;
    // The consumer's own agents run once, beside the first round, over the whole change.
    let mut tasks = extra::tasks(run)?;
    for (track, p) in run.tracks.iter().zip(profiles).filter(|(t, _)| t.live()) {
        let plan = track.plan.as_ref().ok_or(StepError::NoPlan)?;
        let slices = run.units.slices(&p.id);
        tasks.extend(rounds::tasks(
            &run.context,
            (p, plan),
            &track.files,
            slices,
            &run.rounds,
        )?);
        if let Some(unit) = run.units.track(&p.id) {
            let prior = prompts::prior_found_summary(&run.rounds.pool);
            let round = run.rounds.round;
            tasks.extend(units::contract_tasks(
                &run.context,
                p,
                plan,
                unit,
                round,
                &prior,
            )?);
        }
    }
    run.tasks = tasks;
    run.phase = Phase::Lenses;
    Ok(())
}

/// After the last round: the extra lenses' findings into the pool, the lenses that never returned,
/// then the unit-mode coordinators when there are any, else the pool to the dedup.
fn end_rounds(dir: &Path, run: &mut RunState, profiles: &[Profile]) -> Result<(), Error> {
    extra::join(run);
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
    let coordinators = units::seam_tasks(run, profiles)?;
    if !coordinators.is_empty() {
        run.tasks = coordinators;
        run.phase = Phase::Seam;
        return Ok(());
    }
    to_pool(dir, run, profiles)
}

/// The pool to the dedup; an empty one straight to the critic.
fn to_pool(dir: &Path, run: &mut RunState, profiles: &[Profile]) -> Result<(), Error> {
    // Nothing to verify: the critic is still asked whether a lens that did not run should have.
    if run.rounds.pool.is_empty() {
        return critic::ask(dir, run);
    }
    let pool = run.rounds.pool.clone();
    to_dedup(dir, run, profiles, &pool)
}

/// `pool` through the floor and the roll-up, then to the dedup pass when two or more remain, else
/// straight to verification.
fn to_dedup(
    dir: &Path,
    run: &mut RunState,
    profiles: &[Profile],
    pool: &[Value],
) -> Result<(), Error> {
    run.findings = dedup::prepare(pool, profiles);
    let Some(first) = profiles.first().filter(|_| run.findings.len() >= 2) else {
        return start_verify(dir, run);
    };
    let ids: Vec<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
    let mut tasks = vec![Task::new(
        format!("dedup-{}", ids.join("-")),
        format!("dedup:{}", ids.join("-")),
        prompts::dedup_prompt(&run.context, &run.findings)?,
        first.dedup_model,
        content::schema("dedup")?,
        TaskKind::Dedup,
    )];
    crate::critic::relabel(run, &mut tasks);
    run.tasks = tasks;
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
    let mut tasks = verify::tasks(run)?;
    crate::critic::relabel(run, &mut tasks);
    run.tasks = tasks;
    if run.tasks.is_empty() {
        return critic::verified(dir, run);
    }
    run.phase = Phase::Verify;
    Ok(())
}

/// Files the run's round record, which a later run of its branch builds on; a run on no branch
/// files none. Neither does a run its red gate ended before any lens: no lens read its head, so a
/// later round reviewing only the commits since it would leave the branch's own changes unread;
/// the next round builds on the last round that did review, its ledger as it stands — unless the
/// red run was started `fresh`: it files a marker that restarts the chain with nothing to build
/// on, so the next run does not quietly resume the chain `fresh` set aside.
fn file_round(dir: &Path, run: &mut RunState) -> Result<(), Error> {
    let Some(branch) = &run.chain.branch else {
        return Ok(());
    };
    let c = &run.chain;
    let mut record = chain::record(&c.repo, branch, &run.diff.head, c.round, c.ledger.clone());
    record.scope.clone_from(&c.scope);
    if run.gate.exit().is_some() {
        let fresh = c.unchained.as_deref() == Some(chain::Unchained::Fresh.reason());
        if !fresh {
            run.notes.push(
                "this round is not filed for the branch's next round: its gate was red and no lens read it, so the next round builds on the last round that did".into(),
            );
            return Ok(());
        }
        run.notes.push(
            "this round is filed only as the start of a new chain (it was started fresh): its gate was red and no lens read it, so the next round reviews the whole branch with nothing to build on".into(),
        );
        record.ledger = Vec::new();
        record.restart = true;
    }
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
    run.chain.ledger = rereview::ledger(&run.chain, &run.settled);
    run.chain.ledger.extend(run.memory.ledger_rows());
    file_round(dir, run)?;
    crate::publish::settle(run);
    let verdict = report::verdict(run);
    let path = state::report_path(dir);
    std::fs::write(&path, report::markdown(run, &verdict))
        .map_err(|source| StepError::NoReport { path, source })?;
    run.verdict = Some(verdict);
    run.phase = Phase::Done;
    Ok(())
}
