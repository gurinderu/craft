//! Why a name search did not finish: its line cap, or any other reason.

use super::HITS_MAX;

/// Why a name search did not finish.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(in crate::consumers) enum Unfinished {
    /// More lines name it than [`HITS_MAX`].
    #[error("over {} lines", HITS_MAX)]
    Capped,
    /// The deadline, a stop, or git's reason.
    #[error("{0}")]
    Failed(String),
}

impl From<String> for Unfinished {
    fn from(why: String) -> Self {
        Self::Failed(why)
    }
}
