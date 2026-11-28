//! An audit run opened: its arguments refused or kept, its project scouted, the lens agents of
//! its first pass handed out.

use std::path::{Component, Path, PathBuf};

use craft_review::filing::Writer;
use craft_step::Aside;
use serde_json::Value;

use crate::AuditError;
use crate::batch::Tracked;
use crate::scout;
use crate::state::{self, Args, AuditState, Phase, STATE_VERSION};

use super::{advance, filing, step};

/// What an audit run is opened with.
#[derive(Debug, Clone)]
pub struct StartOptions {
    /// A directory inside the repository to audit.
    pub cwd: PathBuf,
    pub run_dir: PathBuf,
    pub args: Args,
}

/// Why `path` cannot name a part of the project, `None` when it can: a path from the repository
/// root, without `.` or `..`.
fn bad_path(path: &str) -> Option<&'static str> {
    if path.trim().is_empty() {
        return Some("it is blank");
    }
    if path.chars().any(char::is_control) {
        return Some("it holds a control character");
    }
    let p = Path::new(path);
    if p.is_absolute() || p.has_root() {
        return Some("it must be a path from the repository root, not an absolute one");
    }
    let dots = p
        .components()
        .any(|c| matches!(c, Component::CurDir | Component::ParentDir));
    dots.then_some("it must not hold `.` or `..`: leave --path out to audit the whole project")
}

/// Refuses what no audit can run with, before any agent.
fn refuse(args: &Args) -> Result<(), AuditError> {
    if args.batch_bytes == 0 {
        return Err(AuditError::Refused(
            "the batch budget must be at least one byte".into(),
        ));
    }
    if args.lens_agents == Some(0) {
        return Err(AuditError::Refused(
            "the lens-agent budget must buy at least one agent".into(),
        ));
    }
    for p in &args.paths {
        if let Some(why) = bad_path(p) {
            return Err(AuditError::Refused(format!(
                "the path {p:?} is refused: {why}"
            )));
        }
    }
    Ok(())
}

/// Refuses a path under which the repository tracks no file: a misspelt path would read as a
/// clean audit of nothing.
fn every_path_holds_files(args: &Args, files: &[Tracked]) -> Result<(), AuditError> {
    for p in &args.paths {
        let p = p.trim_end_matches('/');
        let under = |f: &Tracked| {
            f.path == p
                || f.path
                    .strip_prefix(p)
                    .is_some_and(|rest| rest.starts_with('/'))
        };
        if !files.iter().any(under) {
            return Err(AuditError::Refused(format!(
                "the path {p:?} holds no file git tracks in the working tree"
            )));
        }
    }
    Ok(())
}

/// Checks a new run before its host is asked anything; returns the repository's root.
///
/// # Errors
/// When the arguments, the repository or the run directory are refused.
pub fn check_start(opts: &StartOptions) -> Result<PathBuf, AuditError> {
    refuse(&opts.args)?;
    let cwd = opts
        .cwd
        .canonicalize()
        .map_err(|source| AuditError::NoRepo {
            path: opts.cwd.clone(),
            source,
        })?;
    let root = craft_review::git::toplevel(&cwd).map_err(|e| AuditError::NotGit {
        path: cwd.clone(),
        why: craft_step::left::chain(&e),
    })?;
    let dir = &opts.run_dir;
    // A directory a run filed from is not a new run's: its kept filing would answer for this one.
    if state::state_path(dir).exists() || filing::filing_path(dir).exists() {
        return Err(AuditError::RunExists(dir.clone()));
    }
    Ok(root)
}

/// Opens a run in `opts.run_dir` and hands out its first lens agents; `w` files its record when
/// it records and a pass ends.
///
/// # Errors
/// When the run is refused, the project cannot be listed, or a file cannot be written.
pub fn start(opts: &StartOptions, w: &dyn Writer) -> Result<Value, AuditError> {
    let root = check_start(opts)?;
    let profiles = scout::profiles()?;
    let files = scout::tracked(&root, &opts.args.paths)?;
    every_path_holds_files(&opts.args, &files)?;
    let dir = &opts.run_dir;
    std::fs::create_dir_all(dir).map_err(|source| AuditError::NoDir {
        path: dir.clone(),
        source,
    })?;
    let mut s = AuditState {
        version: STATE_VERSION,
        scout: scout::scout(&files, &profiles, opts.args.batch_bytes),
        cwd: root,
        args: opts.args.clone(),
        phase: Phase::Lens,
        pass: 1,
        tasks: Vec::new(),
        degraded: Vec::new(),
        notes: Vec::new(),
        stopped: None,
    };
    advance::open_pass(&mut s, &profiles)?;
    step(dir, &mut s, Aside::default(), None, w)
}

#[cfg(test)]
mod tests;
