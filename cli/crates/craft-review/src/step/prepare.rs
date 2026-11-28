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

/// The consumers list of the change (realm @nick/craft, node #529), the code graph indexed and
/// asked when the reviewer's profile says it answers, run until the start is stopped; indexed
/// for the metrics lenses too when `metrics` (the binary's one index of it, under its lock).
fn consumers_of(
    cwd: &Path,
    (opts, metrics): (&StartOptions, bool),
    diff: &crate::git::Diff,
) -> crate::consumers::Consumers {
    let projects = opts.sources.as_ref().map(|s| s.projects.as_path());
    let probe = opts.sources.as_ref().map_or("", |s| s.code_graph.as_str());
    crate::consumers::of_checkout(cwd, (projects, probe, metrics), diff, &opts.cancel)
}

/// The embedded-SQL, design and lens signals on each track (the design lens's seed beside them), then
/// the integration points' sources, the gate and the consumers list, side by side, none waiting on
/// another: the sources and the list reach the prompts, the gate's seeds the pool as round-0
/// findings.
pub(super) fn prepare(
    cwd: &Path,
    (dir, profiles): (&Path, &[Profile]),
    opts: &StartOptions,
    run: &mut RunState,
) {
    compose(opts, profiles, run);
    properties(opts, run);
    let taking_part = |p: &&Profile| run.tracks.iter().any(|t| t.profile == p.id);
    let metrics = profiles.iter().filter(taking_part).any(complexity::wanted);
    let sql = crate::embedded_sql::mark(cwd, &run.diff.merge_base, &mut run.tracks);
    run.notes.extend(sql);
    let (seed, design) = crate::design::mark(cwd, &run.diff, &mut run.tracks);
    run.context.design = seed;
    run.notes.extend(design);
    let signals = crate::lens_signal::mark(cwd, &run.diff, &mut run.tracks);
    run.notes.extend(signals);
    let size = crate::size::mark(cwd, &run.diff, &mut run.tracks);
    run.notes.extend(size);
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
        let consumers = s.spawn(|| consumers_of(cwd, (opts, metrics), &run.diff));
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
                run.rounds.pool = seeds
                    .into_iter()
                    .map(|f| crate::dedup::stamped(f, crate::dedup::GATE, None))
                    .collect();
            }
            run.gate = gate;
        }
        None => run.gate = gate::Gate::not_asked(),
    }
    // A red gate ends the run before any lens: its mutants would run for no one.
    if run.gate.exit().is_none() {
        launch_mutants(cwd, dir, opts, run);
    }
}

/// The project's properties the reviewer's profile sets (realm @nick/craft, node #654), named in
/// the report, or why they could not be read — then the plans read the scouts' answers alone.
fn properties(opts: &StartOptions, run: &mut RunState) {
    if !opts.project_unread.is_empty() {
        run.notes.push(format!(
            "the reviewer's profile's [project] section could not be read ({}): the plans take the scouts' answers alone",
            opts.project_unread
        ));
    }
    run.notes.extend(opts.project.line());
    let rules = opts.project.rules.as_deref().unwrap_or_default();
    let kept = crate::plan::repo_rule_paths(rules);
    let refused: Vec<&str> = rules
        .iter()
        .map(|r| craft_store::js::JsStr::js_trim(r.as_str()))
        .filter(|r| !kept.iter().any(|k| k == r.strip_prefix("./").unwrap_or(r)))
        .map(|r| if r.is_empty() { "\"\"" } else { r })
        .collect();
    if !refused.is_empty() {
        run.notes.push(format!(
            "the reviewer's profile's rule files {} were left out — not a short repository-relative path, or past the {} files or {} characters a lens reads: no lens reads them",
            refused.join(", "),
            crate::plan::REPO_RULES_MAX,
            crate::plan::REPO_RULES_MAX_CHARS
        ));
    }
    run.context.project = opts.project.clone();
}

/// The lens composition the reviewer's profile gives the run (realm @nick/craft, node #644), and
/// the line the report says of it: what it turned off and held, that `--all-lenses` set it aside,
/// or why it was refused or could not be read — never silently.
fn compose(opts: &StartOptions, profiles: &[Profile], run: &mut RunState) {
    if !opts.lenses_unread.is_empty() {
        run.notes.push(format!(
            "the reviewer's profile's [lenses] section could not be read ({}): every lens runs as its profile says",
            opts.lenses_unread
        ));
    }
    if opts.lenses.is_empty() {
        return;
    }
    match crate::composition::Composition::of(&opts.lenses, profiles) {
        Err(e) => run.notes.push(format!(
            "the reviewer's profile's [lenses] section was refused ({e}): every lens runs as its profile says"
        )),
        Ok(c) if opts.all_lenses => run.notes.extend(c.line().map(|l| {
            format!("every lens runs (`--all-lenses`), though {l}")
        })),
        Ok(c) => {
            run.notes.extend(c.line());
            run.context.composition = c;
        }
    }
}

/// The mutants of the change, launched to run beside the lens rounds once the Rust gate passed
/// (realm @nick/craft, node #648); a run that will not run them says why.
fn launch_mutants(cwd: &Path, dir: &Path, opts: &StartOptions, run: &mut RunState) {
    let rust: &[String] = run
        .tracks
        .iter()
        .find(|t| t.profile == "rust")
        .map_or(&[], |t| t.files.as_slice());
    let top = crate::git::toplevel(cwd).unwrap_or_else(|_| cwd.to_owned());
    // A run that took another's gate ran none of its own: it runs no mutants either.
    let own_gate = opts.gate_from.is_none() && opts.gate.is_some();
    let setup = match (own_gate, opts.mutants.as_ref()) {
        (true, Some(s)) => Ok(s),
        (true, None) => Err("the binary could not name itself as their worker"),
        (false, _) => Err(
            "the run ran no gate of its own (`--no-gate` or `--gate-from`), and they run the branch's tests as the gate builds it",
        ),
    };
    let (mutants, line) = crate::gate::mutants::launch(&crate::gate::mutants::Launch {
        run_dir: dir,
        top: &top,
        base: &run.diff.base,
        rust_files: rust,
        other_profiles: run.tracks.iter().any(|t| t.profile != "rust"),
        gate: &run.gate,
        setup,
        cancel: &opts.cancel,
    });
    run.context.mutants = mutants.running();
    run.gate.mutants = mutants;
    run.notes.extend(line);
}

/// One scout per profile taking part of the change, each over its own files.
pub(super) fn scouts(run: &RunState, profiles: &[Profile]) -> Result<Vec<Task>, Error> {
    let mut tasks = Vec::new();
    for t in &run.tracks {
        let Some(p) = profiles.iter().find(|p| p.id == t.profile) else {
            continue;
        };
        tasks.push(Task::new(
            format!("scout-{}", p.id),
            format!("scout:{}", p.id),
            prompts::scout_prompt(&run.context, p, &t.read_paths(), t.changed_lines)?,
            p.scout_model,
            crate::size::scout_schema(
                content::schema("scout")?,
                crate::size::told(&p.id, t.changed_lines),
            ),
            TaskKind::Scout {
                profile: p.id.clone(),
            },
        ));
    }
    Ok(tasks)
}
