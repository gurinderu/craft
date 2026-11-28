//! An audit run's state between steps, kept in `state.json` in its run directory: its arguments,
//! what its scout found, the pass it is in, and every task it handed out with what its answer
//! said. The findings, what was read and the verdict are derived from the tasks at each step.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::kind::AuditKind;
use crate::scout::Scouted;

mod args;

pub use args::{Args, Recording};

/// The state file's format; a run another format wrote is refused, not misread.
pub const STATE_VERSION: u32 = 1;

/// One task of an audit run ([`craft_step::Task`]).
pub type Task = craft_step::Task<AuditKind>;

/// Why a run's state could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error("reading the audit state {}", path.display())]
    Unreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("parsing the audit state {}", path.display())]
    Malformed {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error(
        "the audit state {} is of format {found}; this craft reads format {STATE_VERSION} only: start a new audit",
        path.display()
    )]
    Version { path: PathBuf, found: u32 },
    #[error(transparent)]
    Encode(#[from] serde_json::Error),
    #[error("writing {}", path.display())]
    Unwritable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Where a run stands: the agents it waits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Lens,
    Verify,
    Done,
}

/// An audit run between steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditState {
    pub version: u32,
    /// The repository root it audits.
    pub cwd: PathBuf,
    pub args: Args,
    pub scout: Scouted,
    pub phase: Phase,
    /// The pass it is in: the first reads what the budget buys, each resume of a finished run
    /// reads what the passes before left unread.
    pub pass: u32,
    /// Every task handed out, in order.
    pub tasks: Vec<Task>,
    /// How the host ran tasks weaker than asked, each note once.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub degraded: Vec<String>,
    /// What the run noted of its own handling: a refused answer file it could not move aside.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    /// Why the run stopped before its end, its pending tasks held for a resume.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<craft_step::stop::Stop>,
}

/// A state's format, read before its shape.
#[derive(Deserialize)]
struct Format {
    version: u32,
}

/// Where a run's state is kept.
#[must_use]
pub fn state_path(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

/// The run's state in `dir`.
///
/// # Errors
/// When it cannot be read, is not a state, or another format wrote it.
pub fn load(dir: &Path) -> Result<AuditState, StateError> {
    let path = state_path(dir);
    let text = std::fs::read_to_string(&path).map_err(|source| StateError::Unreadable {
        path: path.clone(),
        source,
    })?;
    let malformed = |source| StateError::Malformed {
        path: path.clone(),
        source,
    };
    let found = serde_json::from_str::<Format>(&text)
        .map_err(malformed)?
        .version;
    if found != STATE_VERSION {
        return Err(StateError::Version { path, found });
    }
    serde_json::from_str(&text).map_err(malformed)
}

/// Writes the run's state into `dir`, whole or not at all.
///
/// # Errors
/// When it cannot be encoded or written.
pub fn save(dir: &Path, state: &AuditState) -> Result<(), StateError> {
    let path = state_path(dir);
    let tmp = dir.join("state.json.tmp");
    let text = format!("{}\n", serde_json::to_string_pretty(state)?);
    std::fs::write(&tmp, text).map_err(|source| StateError::Unwritable {
        path: tmp.clone(),
        source,
    })?;
    std::fs::rename(&tmp, &path).map_err(|source| StateError::Unwritable { path, source })
}

#[cfg(test)]
mod tests;
