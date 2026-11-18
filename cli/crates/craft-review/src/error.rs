//! The crate's error: what any step of a run can fail with, each module's own error kept whole.

use crate::content::ContentError;
use crate::git::GitError;
use crate::handoff::HandoffError;
use crate::publish::CommentError;
use crate::state::StateError;
use crate::step::StepError;

/// Why a step of a run failed; each variant forwards its message and source as they are.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Step(#[from] StepError),
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    State(#[from] StateError),
    #[error(transparent)]
    Handoff(#[from] HandoffError),
    #[error(transparent)]
    Content(#[from] ContentError),
    #[error(transparent)]
    Comment(#[from] CommentError),
}

impl Error {
    /// Whether the run was refused for an argument it was given, before any work: the command
    /// exits as a refused argument does.
    #[must_use]
    pub fn refuses_argument(&self) -> bool {
        matches!(self, Self::Step(StepError::DeltaOverBranch { .. }))
    }
}
