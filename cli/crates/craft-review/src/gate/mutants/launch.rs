//! Whether the change's mutants run and where, and the worker started to run them: only once the
//! Rust gate's checks passed — a seed tool that then left the track unknown does not stop them
//! ([`super::super::Track::tests_build`]) — and the run is not being stopped, and cargo-mutants
//! answers `--version` where the gate's cargo ran (inside the flake's dev shell when it did) — so
//! the tests lens is told the binary runs them only when it will
//! ([`crate::prompts::PromptContext::mutants`]).

use std::path::Path;
use std::time::Duration;

use super::super::runner::{Ran, Runner};
use super::super::{Gate, Status};
use super::worker::{self, Request};
use super::{DIR, Mutants, MutantsError, MutantsSetup, not_run};

/// How long the probe of cargo-mutants may take: a dev shell the gate already entered is cached.
const PROBE_MAX: Duration = Duration::from_mins(1);

/// What a run's start knows when it may launch the mutants.
pub(crate) struct Launch<'a> {
    pub run_dir: &'a Path,
    pub top: &'a Path,
    pub base: &'a str,
    /// The Rust track's changed files, repository-relative.
    pub rust_files: &'a [String],
    /// Whether any other profile takes part of the change.
    pub other_profiles: bool,
    pub gate: &'a Gate,
    /// How they run, or why the run has nothing to run them with.
    pub setup: Result<&'a MutantsSetup, &'a str>,
    /// A stop asked of the start: none launches once it is, and it cuts the probe short.
    pub cancel: &'a crate::cancel::Cancel,
}

/// Launches the mutants when the change and its gate allow it: the state to keep, and the lines
/// the report says of them — why they will not run, or the workspaces they leave out.
pub(crate) fn launch(at: &Launch<'_>) -> (Mutants, Vec<String>) {
    let note = at
        .setup
        .ok()
        .map(|s| s.note.as_str())
        .filter(|n| !n.is_empty());
    let mut said: Vec<String> = note
        .map(|n| format!("the reviewer's profile's [mutants] section could not be read ({n}): its defaults were taken"))
        .into_iter()
        .collect();
    match plan(at) {
        Ok(p) => match start(at, &p) {
            Ok(m) => {
                said.extend(left_out(&p.others));
                return (m, said);
            }
            Err(e) => said.push(not_run(&format!("the worker could not start: {e}"))),
        },
        Err(Some(why)) => said.push(not_run(&why)),
        Err(None) => {}
    }
    (Mutants::default(), said)
}

fn left_out(others: &[String]) -> Option<String> {
    (!others.is_empty()).then(|| {
        format!(
            "mutants of the change ran in one cargo workspace only: the changed Rust of {} got none",
            others.iter().map(|w| format!("`{}`", if w.is_empty() { "." } else { w })).collect::<Vec<_>>().join(", ")
        )
    })
}

/// Where and how they run.
struct Plan<'a> {
    workspace: String,
    /// The other workspaces the change touched, left out.
    others: Vec<String>,
    inside: bool,
    setup: &'a MutantsSetup,
}

/// The plan; `Err` the reason they do not run, or `None` when the change has nothing they could
/// run on and nothing to say.
fn plan<'a>(at: &Launch<'a>) -> Result<Plan<'a>, Option<String>> {
    if at.rust_files.is_empty() {
        return Err(at.other_profiles.then(|| {
            "the change has no Rust; cargo-mutants is the only mutation tool craft runs on a diff".to_owned()
        }));
    }
    let setup = allowed(at)?;
    let track = at.gate.tracks.iter().find(|t| t.profile == "rust");
    let Some(track) = track.filter(|t| t.tests_build()) else {
        let status = track.map_or("did not run", |t| status_word(t.status));
        return Err(Some(format!(
            "the Rust gate {status}, so the tests they rely on are not known to build"
        )));
    };
    let mut roots = workspaces(at.top, at.rust_files).into_iter();
    let workspace = roots
        .next()
        .ok_or_else(|| Some("no Cargo package holds the changed Rust files".to_owned()))?;
    probe(at, setup, track.dev_shell).map_err(Some)?;
    if at.cancel.is_cancelled() {
        return Err(Some("the run was stopped before they started".into()));
    }
    Ok(Plan {
        workspace,
        others: roots.collect(),
        inside: track.dev_shell,
        setup,
    })
}

/// The setup, when the run may launch them at all.
fn allowed<'a>(at: &Launch<'a>) -> Result<&'a MutantsSetup, Option<String>> {
    if at.cancel.is_cancelled() {
        return Err(Some("the run was stopped before they started".into()));
    }
    let setup = at.setup.map_err(|why| Some(why.to_owned()))?;
    if setup.off {
        return Err(Some("off in the reviewer's profile".into()));
    }
    if !cfg!(unix) {
        return Err(Some("they run only on Unix hosts".into()));
    }
    Ok(setup)
}

fn status_word(s: Status) -> &'static str {
    match s {
        Status::Fail => "is red",
        Status::Unknown => "could not establish its signal",
        Status::Nothing => "had nothing to check",
        Status::Pass => "passed",
    }
}

/// Whether `cargo mutants --version` answers where the gate's cargo ran; `Err` why not.
fn probe(at: &Launch<'_>, setup: &MutantsSetup, inside: bool) -> Result<(), String> {
    let runner = Runner::new(PROBE_MAX, None, at.run_dir.join(DIR).join("probe"))
        .stopped_by(at.cancel.clone());
    let args = ["mutants", "--version"];
    let ran = if inside {
        runner.run(
            at.top,
            &setup.nix,
            &super::super::devshell::inside(&setup.cargo, &args),
        )
    } else {
        runner.run(at.top, &setup.cargo, &args)
    };
    match ran {
        Ran::Exited { ok: true, .. } => Ok(()),
        Ran::Exited { err, .. } if err.contains("no such command") => {
            Err("cargo-mutants is not installed where the gate's cargo runs".into())
        }
        Ran::Missing => Err(format!(
            "{} is not on the PATH the gate's cargo ran on",
            if inside { &setup.nix } else { &setup.cargo }
        )),
        Ran::Exited { err, .. } => Err(format!(
            "`cargo mutants --version` failed: {}",
            super::super::check::last_line(&err)
        )),
        Ran::TimedOut(d) => Err(format!(
            "`cargo mutants --version` did not answer in {}s",
            d.as_secs()
        )),
        Ran::Broken(e) => Err(format!("`cargo mutants --version` could not run: {e}")),
    }
}

/// The cargo workspaces of `files`, repository-relative, the one holding most of them first.
fn workspaces(top: &Path, files: &[String]) -> Vec<String> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for root in files.iter().filter_map(|f| root_of(top, f)) {
        match counts.iter_mut().find(|(r, _)| *r == root) {
            Some((_, n)) => *n += 1,
            None => counts.push((root, 1)),
        }
    }
    counts.sort_by_key(|c| std::cmp::Reverse(c.1));
    counts.into_iter().map(|(r, _)| r).collect()
}

/// From `file`'s directory up to `top`, the nearest `Cargo.toml` declaring a workspace (a
/// `[workspace]` table or one of its dotted tables) — a nested workspace is a root of its own, as
/// cargo reads it —, else the nearest `Cargo.toml`.
fn root_of(top: &Path, file: &str) -> Option<String> {
    let mut dir = Path::new(file).parent();
    let mut nearest = None;
    while let Some(d) = dir {
        if let Ok(text) = std::fs::read_to_string(top.join(d).join("Cargo.toml")) {
            let rel = d.display().to_string();
            let table = |l: &str| l.starts_with("[workspace]") || l.starts_with("[workspace.");
            if text.lines().any(|l| table(l.trim_start())) {
                return Some(rel);
            }
            nearest.get_or_insert(rel);
        }
        dir = d.parent();
    }
    nearest
}

/// Writes the request and starts the worker, not waiting on it; its stderr kept in the run.
fn start(at: &Launch<'_>, p: &Plan<'_>) -> Result<Mutants, MutantsError> {
    let dir = at.run_dir.join(DIR);
    let io = |what: &str| {
        let what = format!("{what} in {}", dir.display());
        move |source| MutantsError::Io { what, source }
    };
    std::fs::create_dir_all(&dir).map_err(io("creating the mutants' directory"))?;
    let req = Request {
        top: at.top.to_owned(),
        workspace: p.workspace.clone(),
        base: at.base.to_owned(),
        inside: p.inside,
        budget_secs: p.setup.budget.as_secs(),
        cargo: p.setup.cargo.clone(),
        nix: p.setup.nix.clone(),
    };
    let text = serde_json::to_string(&req).map_err(|source| MutantsError::Json {
        what: "the worker's request".into(),
        source,
    })?;
    std::fs::write(dir.join(worker::REQUEST), text).map_err(io("writing the request"))?;
    let err =
        std::fs::File::create(dir.join(worker::ERR)).map_err(io("creating the worker's log"))?;
    let mut cmd = std::process::Command::new(&p.setup.exe);
    cmd.arg("__craft-mutants")
        .arg(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(err);
    // A session of its own: the step that started it ends without it.
    crate::cancel::detached(&mut cmd);
    cmd.spawn().map_err(io("starting the worker"))?;
    Ok(Mutants {
        dir: dir.display().to_string(),
        top: at.top.display().to_string(),
        workspace: p.workspace.clone(),
        base: at.base.to_owned(),
        joined: false,
        short: String::new(),
    })
}

#[cfg(test)]
pub(super) fn workspaces_of(top: &Path, files: &[String]) -> Vec<String> {
    workspaces(top, files)
}
