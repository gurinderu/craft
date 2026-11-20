//! Opening a run: its directory, where it reviews, the change it reads, and the refusal of a delta
//! round over the whole branch.

use std::path::{Path, PathBuf};

use super::{StartOptions, StepError};
use crate::Error;
use crate::git;
use crate::handoff;
use crate::prompts::ReScope;
use crate::rereview;
use crate::state;

/// Where the run reviews: craft's own worktree of the pull request given, with the line naming
/// it, when `cwd`'s `HEAD` does not hold its head and the run is no nested one (realm
/// `@nick/craft`, node #517); else `cwd`.
pub(super) fn pr_worktree(
    cwd: PathBuf,
    dir: &Path,
    opts: &StartOptions,
) -> Result<(PathBuf, Option<rereview::branch::Laid>), StepError> {
    if opts.nested {
        return Ok((cwd, None));
    }
    let laid = rereview::branch::checkout(
        &cwd,
        &opts.chain_lookup(dir),
        opts.worktrees.as_deref(),
        opts.runtime.is_none(),
    )
    .map_err(StepError::PrHead)?;
    Ok((laid.as_ref().map_or(cwd, |l| l.dir.clone()), laid))
}

/// The scope the run reviews (`path`, repository-relative) and the branch's change under it.
pub(super) fn read_change(
    cwd: &Path,
    opts: &StartOptions,
) -> Result<(Option<String>, git::Diff), Error> {
    let scope = match opts.path.as_deref() {
        Some(p) => crate::scope::normalize(&git::toplevel(cwd)?, p).map_err(StepError::from)?,
        None => None,
    };
    let diff = git::read_diff(cwd, opts.base.as_deref(), scope.as_deref())?;
    Ok((scope, diff))
}

/// A delta round whose change starts at or before where the branch leaves origin's default
/// branch — the base given, the default, or a prior round's head the branch was rebased past —
/// is refused before any task (realm @nick/craft, node #523): `diff` is what the round reviews,
/// the fix commits since a prior round's head when the chain has one. A re-scan has a prior round
/// behind it and is let through, as is a run whose default branch cannot be found, as nothing can
/// be said of it.
pub(super) fn refuse_delta_over_branch(
    cwd: &Path,
    delta: bool,
    re_review: ReScope,
    diff: &git::Diff,
) -> Result<(), StepError> {
    if !delta || re_review == ReScope::Rescan {
        return Ok(());
    }
    match git::trunk_point(cwd) {
        Some((trunk, point)) if git::holds(cwd, &point, &diff.merge_base) => {
            Err(StepError::DeltaOverBranch {
                base: diff.base.clone(),
                point,
                trunk,
            })
        }
        _ => Ok(()),
    }
}

/// Makes `dir` the new run's: refused when it holds a run, or a task or answer file that would be
/// read as this run's.
pub(super) fn open_dir(dir: &Path) -> Result<(), StepError> {
    if state::state_path(dir).exists() {
        return Err(StepError::RunExists(dir.to_owned()));
    }
    for sub in [handoff::tasks_dir(dir), handoff::answers_dir(dir)] {
        if sub.read_dir().is_ok_and(|mut d| d.next().is_some()) {
            return Err(StepError::Leftovers(sub));
        }
    }
    std::fs::create_dir_all(dir).map_err(|source| StepError::NoDir {
        path: dir.to_owned(),
        source,
    })
}
