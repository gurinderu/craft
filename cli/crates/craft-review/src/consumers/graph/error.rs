//! Why the code graph was not asked, or gave no callers.

use super::super::cbm::{self, CbmError};
use super::super::fresh::Stale;

/// Why the code graph was not asked, or gave no callers; its text is the report's line.
#[derive(Debug, thiserror::Error)]
pub enum GraphError {
    #[error("no review profile directory")]
    NoProfiles,
    #[error("the review profile could not be read: {0}")]
    Profile(String),
    #[error(
        "the review profile names no code graph (`craft init --propose` checks for one and \
         prints the write that records it)"
    )]
    NotRecorded,
    #[error(
        "`craft init` found {tool} unusable: {note}; once it answers and indexes this repository, {}",
        cbm::RECORD
    )]
    Unusable { tool: String, note: String },
    #[error("{0}")]
    Cbm(#[from] CbmError),
    #[error("the change has no symbol to ask the graph of, so it was neither indexed nor asked")]
    NothingToAsk,
    #[error("the index of {project} names no root it indexes, so whose it is cannot be told")]
    NoRoot { project: String },
    #[error(
        "the index of {project} is of {root}, not of this checkout ({checkout}): another review \
         moved it after this one indexed it"
    )]
    Foreign {
        project: String,
        root: String,
        checkout: String,
    },
    #[error("{0}")]
    Stale(#[from] Box<Stale>),
    #[error("the graph could not index this checkout ({checkout}) in time for the list: {why}")]
    Reindex { checkout: String, why: CbmError },
    #[error(
        "the index of {project} changed while its callers were asked (another run indexed it): \
         its answers are not used"
    )]
    Moved { project: String },
}
