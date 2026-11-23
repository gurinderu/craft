//! Why a doubtful finding was not posted.

use craft_store::sorting::posting::MarkError;

/// Why nothing was posted.
#[derive(Debug, thiserror::Error)]
pub enum PostError {
    /// The record lists no such finding, or it names no file.
    #[error("{0}")]
    Finding(String),
    /// The pull request cannot be told or takes no comment: none, several, one of another branch
    /// (`--pr`), a fork's, one not open, or one whose head does not hold the reviewed commit.
    #[error("{0}")]
    Pr(String),
    /// gh failed, or the PR names no commit to post on.
    #[error("{0}")]
    Gh(String),
    /// The PR could not be noted in the record before the post: the record refused it, or could
    /// not be read or written ([`MarkError::is_refusal`] tells them apart).
    #[error("PR #{pr} could not be noted in the record before posting: {source} — nothing posted")]
    Remember {
        pr: u64,
        #[source]
        source: MarkError,
    },
    /// The PR's head, missing here, could not be fetched from `origin` in time.
    #[error("{0}")]
    Fetch(String),
    /// The review read uncommitted work, or the PR's head moved past the reviewed head over the
    /// finding's line.
    #[error("nothing was posted: {0}")]
    Refused(String),
}
