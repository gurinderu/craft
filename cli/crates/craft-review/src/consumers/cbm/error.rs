//! Why the code graph gave no answer.

use std::time::Duration;

/// Why one question to the graph, or a review's run of them, gave no answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CbmError {
    /// The program could not be started or waited on.
    #[error("{0}")]
    Spawn(String),
    /// One question ran past its own limit.
    #[error("no answer within {}s", .0.as_secs())]
    Timeout(Duration),
    /// The review's budget for asking callers ran out.
    #[error("time bound")]
    TimeBound,
    /// Another review holds the index lock of the project past the time left.
    #[error("another review is indexing {project} (lock {lock}) past the time left")]
    Locked { project: String, lock: String },
    /// The index ran past the time left; it goes on in the background, holding the lock.
    #[error(
        "its index ran past the time left ({}s); it goes on in the background and a later review \
         asks it",
        .0.as_secs()
    )]
    StillIndexing(Duration),
    /// The run was stopped while the graph was asked.
    #[error("{}", crate::cancel::STOPPED)]
    Stopped,
    /// The program's output could not be read whole.
    #[error("{0}")]
    Output(String),
    /// The graph answered with an error, or with something that is not its answer.
    #[error("{0}")]
    Graph(String),
}
