//! What a run that goes on to its lenses prepares before them: the sources, the gate and the
//! consumers list side by side, the slices of the change, the extra lenses, and the scouts.

use std::path::Path;

use super::StartOptions;
use crate::Error;
use crate::complexity;
use crate::content;
use crate::extra;
use crate::gate::{self, GateSetup};
use crate::git;
use crate::profile::Profile;
use crate::prompts;
use crate::sources;
use crate::state::{RunState, Task, TaskKind};
use crate::units;

/// The slices of the change when the run goes on to its lenses: under unit mode, when asked, the
/// units of each profile taking part, discovered in the repository's top level, and their batches;
/// else the normal mode's directory slices.
pub(super) fn choose_units(cwd: &Path, asked: bool, run: &mut RunState, profiles: &[Profile]) {
    run.units.asked = asked;
    if run.exit.is_some() {
        return;
    }
    let top = git::toplevel(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let d = &run.diff;
    run.units = units::open(asked, &top, &d.base, &d.files, &run.tracks, profiles);
}

/// The extra lenses the run is asked for, discovered among the session project's agents when it
/// asks for discovery and goes on to its lenses; a run ending here says they did not run.
pub(super) fn choose_extra(cwd: &Path, opts: &StartOptions, run: &mut RunState) {
    run.extra = extra::request(opts.extra_lenses.as_deref(), opts.light);
    if run.exit.is_some() {
        extra::not_reached(run);
        return;
    }
    if run.extra.how == extra::How::Discovered {
        let session = opts
            .session
            .clone()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| cwd.to_path_buf());
        let (agents, read) = extra::discover(&session, cwd);
        run.extra.agents = agents;
        run.extra.discovery = read;
    }
}

/// The embedded-SQL signal on each track, then the integration points' sources, the gate and the
/// consumers list, side by side, none waiting on another: the sources and the list reach the
/// prompts, the gate's seeds the pool as round-0 findings.
pub(super) fn prepare(cwd: &Path, dir: &Path, opts: &StartOptions, run: &mut RunState) {
    crate::embedded_sql::mark(cwd, &run.diff.merge_base, &mut run.tracks);
    let (prepared, gated, listed) = std::thread::scope(|s| {
        let sources = s.spawn(|| {
            opts.sources
                .as_ref()
                .map(|setup| sources::SourcesSetup {
                    git: setup.git.stopped_by(opts.cancel.clone()),
                    ..setup.clone()
                })
                .map(|setup| sources::for_repo(cwd, &setup))
        });
        // Started before the gate, which runs on this thread, so the two overlap.
        let consumers = s.spawn(|| crate::consumers::of_checkout(cwd, &run.diff, &opts.cancel));
        let gated = match &opts.gate_from {
            Some(from) => Some(gate::alone::taken(from, &run.diff)),
            None => opts
                .gate
                .as_ref()
                .map(|setup| GateSetup {
                    scope: run.context.scope.clone(),
                    // In craft's own worktree of the PR, which other runs on its head share.
                    locked: run.chain.worktree.is_some(),
                    cancel: opts.cancel.clone(),
                    ..setup.clone()
                })
                .map(|setup| gate::run(cwd, &run.diff.base, &run.tracks, &setup, dir)),
        };
        (sources.join(), gated, consumers.join())
    });
    let (lens, note) = crate::consumers::prepare(dir, listed);
    run.context.consumers = lens;
    run.notes.extend(note);
    match prepared {
        Ok(Some(s)) => run.context.sources = s,
        Ok(None) => {}
        Err(_) => {
            run.context.sources.skipped = "the sources' preparation stopped unexpectedly".into();
        }
    }
    match gated {
        Some((gate, seeds)) => {
            // A red gate ends the run before any lens: its seeds are no one's to read.
            if gate.exit().is_none() {
                run.rounds.pool = seeds;
            }
            run.gate = gate;
        }
        None => run.gate = gate::Gate::not_asked(),
    }
}

/// One scout per profile taking part of the change, each over its own files; beside them the index
/// warm-up when a profile taking part has a metrics-or-nothing lens.
pub(super) fn scouts(run: &RunState, profiles: &[Profile]) -> Result<Vec<Task>, Error> {
    let mut tasks = Vec::new();
    for t in &run.tracks {
        let Some(p) = profiles.iter().find(|p| p.id == t.profile) else {
            continue;
        };
        tasks.push(Task::new(
            format!("scout-{}", p.id),
            format!("scout:{}", p.id),
            prompts::scout_prompt(&run.context, p, &t.files)?,
            p.scout_model,
            content::schema("scout")?,
            TaskKind::Scout {
                profile: p.id.clone(),
            },
        ));
    }
    let taking_part = |p: &&Profile| run.tracks.iter().any(|t| t.profile == p.id);
    if profiles.iter().filter(taking_part).any(complexity::wanted) {
        tasks.push(complexity::warmup_task(&run.context.repo)?);
    }
    Ok(tasks)
}
