//! The crate's error: what any step of a run can fail with, each module's own error kept whole.

use crate::content::ContentError;
use crate::git::GitError;
use crate::handoff::HandoffError;
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
}
