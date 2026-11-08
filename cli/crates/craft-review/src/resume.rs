//! A stopped or interrupted run goes on only over the tree it started on: its lenses' answers so
//! far, its round record and the comments it posts all name the head it read, so a resume after a
//! new commit or an edit of a tracked file is refused and a new review is asked for.

use std::path::Path;

use crate::Error;
use crate::git;
use crate::state::RunState;
use crate::step::StepError;

/// Refuses to resume `run` when `HEAD` names another commit than the one it started on, or the
/// tracked files' changes against it differ from those it read; a state written before the
/// fingerprint ([`git::Diff::worktree`]) is held to its head alone.
///
/// # Errors
/// [`StepError::Moved`] or [`StepError::Changed`], or when git cannot read the repository.
pub(crate) fn unmoved(run: &RunState) -> Result<(), Error> {
    let repo = Path::new(&run.context.repo);
    let started = &run.diff;
    let head = git::git(repo, &["rev-parse", "HEAD"])?.trim().to_owned();
    if head != started.head {
        return Err(StepError::Moved {
            old: short(&started.head).to_owned(),
            new: short(&head).to_owned(),
        }
        .into());
    }
    if !started.worktree.is_empty() && git::worktree(repo)? != started.worktree {
        return Err(StepError::Changed(short(&head).to_owned()).into());
    }
    Ok(())
}

/// A commit's name as a person reads it: its first twelve characters.
fn short(commit: &str) -> &str {
    commit.get(..12).unwrap_or(commit)
}
