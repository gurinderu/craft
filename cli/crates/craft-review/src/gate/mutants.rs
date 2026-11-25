//! Mutants of the change's own lines (realm @nick/craft, node #648): whether a test fails when a
//! changed line breaks has one answer, and cargo-mutants gives it, so the binary runs it rather
//! than a lens reasoning about it. `review start` launches it once the Rust gate passed, in the
//! gate's environment, as a process of its own that bounds itself ([`worker`]): the driver gives
//! `start` 600 s, most of which the gate and the sources already take, so the mutants run beside
//! the lens rounds. When the rounds end the binary joins it — waits what is left of [`JOIN_MAX`],
//! then stops it and takes what it got — and each mutant that survived in a function the change
//! touched is pooled as a tool's finding ([`findings`]). Every run says what came of them: run,
//! run short, or not run and why. Unix only: elsewhere the run says they did not run.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Gate, Status};

mod findings;
mod outcomes;
mod worker;

pub use worker::work;
use worker::{Came, Request};

/// How long the mutants may run by default: beside the lens rounds, which take longer on most
/// changes (realm @nick/craft, node #649: to be measured).
pub const BUDGET: Duration = Duration::from_secs(600);
/// How long joining waits for a worker still running before it stops it.
const JOIN_MAX: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(200);
/// The run directory's part the worker writes into.
const DIR: &str = "mutants";

/// How a run's mutants are run.
#[derive(Debug, Clone)]
pub struct MutantsSetup {
    /// The craft binary, whose hidden `__craft-mutants` command is the worker.
    pub exe: PathBuf,
    pub budget: Duration,
    /// Off in the reviewer's profile.
    pub off: bool,
    /// The program cargo is: `cargo`, or a stand-in under test.
    pub cargo: String,
    /// Why the reviewer's profile's `[mutants]` section could not be read, the defaults taken; ''
    /// when it was.
    pub note: String,
}

/// Where a run's mutants stand.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Mutants {
    /// The worker's directory, while it is to be joined; empty when none was launched.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub dir: String,
    /// The checkout's top level and the workspace it ran in, repository-relative.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub top: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub workspace: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub base: String,
    /// Whether it was joined.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub joined: bool,
}

impl Mutants {
    /// Whether none was launched.
    #[must_use]
    pub fn is_none(&self) -> bool {
        self.dir.is_empty()
    }

    /// Whether a worker was launched and not yet joined.
    #[must_use]
    pub fn running(&self) -> bool {
        !self.dir.is_empty() && !self.joined
    }
}

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
    pub setup: Option<&'a MutantsSetup>,
}

/// Launches the mutants when the change and its gate allow it: the state to keep, and the line
/// the report says when they will not run.
pub(crate) fn launch(at: &Launch<'_>) -> (Mutants, Vec<String>) {
    let note = at.setup.map(|s| s.note.as_str()).filter(|n| !n.is_empty());
    let note = note.map(|n| format!("the reviewer's profile's [mutants] section could not be read ({n}): its defaults were taken"));
    let (m, line) = launch_one(at);
    (m, note.into_iter().chain(line).collect())
}

fn launch_one(at: &Launch<'_>) -> (Mutants, Option<String>) {
    match plan(at) {
        Ok((workspace, inside, setup)) => match start(at, &workspace, inside, setup) {
            Ok(m) => (m, None),
            Err(e) => (
                Mutants::default(),
                Some(not_run(&format!("the worker could not start: {e}"))),
            ),
        },
        Err(None) => (Mutants::default(), None),
        Err(Some(why)) => (Mutants::default(), Some(not_run(&why))),
    }
}

fn not_run(why: &str) -> String {
    format!("mutants of the change did not run: {why}")
}

/// The workspace to run in and whether inside the dev shell; `Err` the reason they do not run, or
/// `None` when the change has nothing they could run on and nothing to say.
fn plan<'a>(at: &Launch<'a>) -> Result<(String, bool, &'a MutantsSetup), Option<String>> {
    if at.rust_files.is_empty() {
        return Err(at.other_profiles.then(|| {
            "the change has no Rust; cargo-mutants is the only mutation tool craft runs on a diff".to_owned()
        }));
    }
    let Some(setup) = at.setup else {
        return Err(Some("the run ran no gate of its own (`--no-gate` or `--gate-from`), and they run the branch's tests as the gate builds it".into()));
    };
    if setup.off {
        return Err(Some("off in the reviewer's profile".into()));
    }
    if !cfg!(unix) {
        return Err(Some("they run only on Unix hosts".into()));
    }
    let track = at.gate.tracks.iter().find(|t| t.profile == "rust");
    let Some(track) = track.filter(|t| t.status == Status::Pass) else {
        let status = track.map_or("did not run", |t| status_word(t.status));
        return Err(Some(format!(
            "the Rust gate {status}, so the tests they rely on are not known to build"
        )));
    };
    let workspace = workspace(at.top, at.rust_files)
        .ok_or_else(|| Some("no Cargo package holds the changed Rust files".to_owned()))?;
    Ok((workspace, track.dev_shell, setup))
}

fn status_word(s: Status) -> &'static str {
    match s {
        Status::Fail => "is red",
        Status::Unknown => "could not establish its signal",
        Status::Nothing => "had nothing to check",
        Status::Pass => "passed",
    }
}

/// The workspace most of `files` are in, repository-relative: from each file's directory up to
/// `top`, the topmost `Cargo.toml` declaring `[workspace]`, else the nearest `Cargo.toml`.
fn workspace(top: &Path, files: &[String]) -> Option<String> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for f in files {
        let Some(root) = root_of(top, f) else {
            continue;
        };
        match counts.iter_mut().find(|(r, _)| *r == root) {
            Some((_, n)) => *n += 1,
            None => counts.push((root, 1)),
        }
    }
    counts.into_iter().max_by_key(|(_, n)| *n).map(|(r, _)| r)
}

fn root_of(top: &Path, file: &str) -> Option<String> {
    let mut dir = Path::new(file).parent();
    let (mut nearest, mut declared) = (None, None);
    while let Some(d) = dir {
        let manifest = top.join(d).join("Cargo.toml");
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            let rel = d.display().to_string();
            nearest.get_or_insert_with(|| rel.clone());
            if text.lines().any(|l| l.trim() == "[workspace]") {
                declared = Some(rel);
            }
        }
        dir = d.parent();
    }
    declared.or(nearest)
}

/// Writes the request and starts the worker, not waiting on it.
fn start(
    at: &Launch<'_>,
    workspace: &str,
    inside: bool,
    setup: &MutantsSetup,
) -> Result<Mutants, String> {
    let dir = at.run_dir.join(DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let req = Request {
        top: at.top.to_owned(),
        workspace: workspace.to_owned(),
        base: at.base.to_owned(),
        inside,
        budget_secs: setup.budget.as_secs(),
        cargo: setup.cargo.clone(),
    };
    let text = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(worker::REQUEST), text).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&setup.exe);
    cmd.arg("__craft-mutants")
        .arg(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // A session of its own: the step that started it ends without it, and one stop of its group
    // reaches every test cargo-mutants runs.
    crate::cancel::detached(&mut cmd);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(Mutants {
        dir: dir.display().to_string(),
        top: at.top.display().to_string(),
        workspace: workspace.to_owned(),
        base: at.base.to_owned(),
        joined: false,
    })
}

/// Joins a launched worker: waits what is left of `wait`, stops it past that, and returns the
/// survivors' findings and the line the report says of the run. Nothing when none was launched.
pub(crate) fn join(m: &mut Mutants, wait: Duration) -> (Vec<Value>, Option<String>) {
    if !m.running() {
        return (Vec::new(), None);
    }
    m.joined = true;
    let dir = PathBuf::from(&m.dir);
    let came = wait_for(&dir, wait);
    let stopped = came.is_none();
    if stopped {
        stop(&dir);
    }
    let lines = match crate::git::zero_context_diff(Path::new(&m.top), &m.base) {
        Ok(d) => super::lines::Lines::parse(&d),
        Err(e) => {
            return (
                Vec::new(),
                Some(format!(
                    "mutants of the change ran, but the change's lines could not be read ({e}): no survivor was kept"
                )),
            );
        }
    };
    let read = std::fs::read_to_string(dir.join("mutants.out").join("outcomes.json"));
    let Ok(text) = read else {
        return (
            Vec::new(),
            Some(not_run(&came.map_or_else(
                || "stopped at the join before cargo-mutants wrote anything".into(),
                |c| why_none(&c),
            ))),
        );
    };
    match outcomes::parse(&text) {
        Ok(o) => said(&o, (&m.workspace, &dir), &lines, stopped),
        Err(e) => (
            Vec::new(),
            Some(format!(
                "mutants of the change ran, but their outcomes could not be read: {e}"
            )),
        ),
    }
}

/// The default join: [`JOIN_MAX`].
pub(crate) fn join_now(m: &mut Mutants) -> (Vec<Value>, Option<String>) {
    join(m, JOIN_MAX)
}

/// Stops a worker that was launched and never joined (the run ended before its rounds did).
pub(crate) fn abandon(m: &mut Mutants) {
    if m.running() {
        m.joined = true;
        let dir = PathBuf::from(&m.dir);
        if wait_for(&dir, Duration::ZERO).is_none() {
            stop(&dir);
        }
    }
}

fn why_none(c: &Came) -> String {
    match c {
        Came::Missing => "cargo-mutants is not installed where the gate's cargo runs".into(),
        Came::TimedOut { secs } => format!("their budget ran out after {secs}s before any outcome"),
        Came::Broken { message } => message.clone(),
        Came::Exited { code } => format!("cargo-mutants exited ({code:?}) without outcomes"),
    }
}

/// What the run came to: the survivors kept and the report's line.
fn said(
    o: &outcomes::Outcomes,
    (workspace, dir): (&str, &Path),
    lines: &super::lines::Lines,
    stopped: bool,
) -> (Vec<Value>, Option<String>) {
    if !o.baseline_ok {
        let log = dir.join("mutants.out").join("log").join("baseline.log");
        let why = format!(
            "the unmutated workspace did not build or pass its tests in cargo-mutants' copy of it, so no mutant's outcome means anything — a crate that reads files outside its workspace fails there (realm @nick/craft, node #653); its log: {}",
            log.display()
        );
        return (Vec::new(), Some(not_run(&why)));
    }
    if o.total == 0 {
        return (Vec::new(), Some("mutants of the change: cargo-mutants chose none on a diff that touches Rust — check the diff's paths against the workspace root (node #624) before reading it as clean".into()));
    }
    let (found, neighbours) = findings::of(&o.missed, workspace, lines);
    let short = if o.complete && !stopped {
        String::new()
    } else {
        format!(
            " — run short: {} of {} tested before it was stopped, the rest neither survived nor died",
            o.tested, o.total
        )
    };
    let left = if neighbours > 0 {
        format!(
            "; {neighbours} more survived in neighbouring functions the change did not touch, left out"
        )
    } else {
        String::new()
    };
    let line = format!(
        "mutants of the change: {} survived of {} tested ({} caught, {} timed out, {} unviable){left}{short}",
        found.len(),
        o.tested,
        o.caught,
        o.timeout,
        o.unviable
    );
    (found, Some(line))
}

/// The worker's result, once it wrote one within `wait`.
fn wait_for(dir: &Path, wait: Duration) -> Option<Came> {
    let until = Instant::now() + wait;
    loop {
        if let Ok(text) = std::fs::read_to_string(dir.join(worker::RESULT)) {
            return serde_json::from_str(&text).ok();
        }
        if Instant::now() >= until {
            return None;
        }
        std::thread::sleep(POLL);
    }
}

/// Stops the worker and cargo-mutants' group, each the leader of a session of its own: the group
/// reaches the tests cargo-mutants runs. Called only while the worker wrote no result, so the ids
/// are still theirs.
fn stop(dir: &Path) {
    #[cfg(unix)]
    for file in [worker::GROUP, worker::PID] {
        let pid = std::fs::read_to_string(dir.join(file)).ok();
        if let Some(pid) = pid.and_then(|p| p.trim().parse::<i32>().ok()) {
            crate::cancel::stop_group_of(pid);
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests;
