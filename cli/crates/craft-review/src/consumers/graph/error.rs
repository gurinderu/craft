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
    #[error("the index of {project} names no root it indexes, so whose it is cannot be told")]
    NoRoot { project: String },
    #[error("the index of {project} is of {root}, not of this repository ({roots})")]
    Foreign {
        project: String,
        root: String,
        roots: String,
    },
    #[error("{0}")]
    Stale(#[from] Box<Stale>),
}
