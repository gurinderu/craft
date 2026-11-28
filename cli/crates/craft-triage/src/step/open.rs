//! A triage run opened: its arguments refused or kept, its first tasks handed out.

use std::path::PathBuf;

use craft_review::filing::Writer;
use craft_step::Aside;
use serde_json::Value;

use crate::TriageError;
use crate::run::{Args, Phase};
use crate::state::{self, STATE_VERSION, TriageState};

use super::refuse::refuse;
use super::{filing, step};

/// What a triage run is opened with.
#[derive(Debug, Clone)]
pub struct StartOptions {
    /// The checkout the session runs in; `args.repo` names another.
    pub cwd: PathBuf,
    pub run_dir: PathBuf,
    pub args: Args,
}

/// Opens a run in `opts.run_dir` and hands out its first tasks; `w` files its record when it
/// records and ends.
///
/// # Errors
/// When the repository cannot be read, the run directory holds a run already, or the state or a
/// task's files cannot be written.
pub fn start(opts: &StartOptions, w: &dyn Writer) -> Result<Value, TriageError> {
    let cwd = check_start(opts)?;
    let dir = &opts.run_dir;
    std::fs::create_dir_all(dir).map_err(|source| TriageError::NoDir {
        path: dir.clone(),
        source,
    })?;
    let mut s = TriageState {
        version: STATE_VERSION,
        cwd,
        args: opts.args.clone(),
        phase: Phase::Gather,
        tasks: Vec::new(),
        seen: state::Seen::default(),
        degraded: Vec::new(),
        notes: Vec::new(),
        stopped: None,
    };
    step(dir, &mut s, Aside::default(), None, w)
}

/// Checks a new run before its host is asked anything; returns its resolved repository.
///
/// # Errors
/// When arguments, the repository or the run directory are refused.
pub fn check_start(opts: &StartOptions) -> Result<PathBuf, TriageError> {
    refuse(&opts.args)?;
    let repo = if opts.args.repo.is_empty() {
        opts.cwd.clone()
    } else {
        PathBuf::from(&opts.args.repo)
    };
    let cwd = repo
        .canonicalize()
        .map_err(|source| TriageError::NoRepo { path: repo, source })?;
    let dir = &opts.run_dir;
    // A directory a run filed from is not a new run's: its kept filing would answer for this one,
    // and the degraded notes a host kept there would be read as this run's.
    if state::state_path(dir).exists()
        || filing::filing_path(dir).exists()
        || craft_step::noted::file(dir).exists()
    {
        return Err(TriageError::RunExists(dir.clone()));
    }
    Ok(cwd)
}
