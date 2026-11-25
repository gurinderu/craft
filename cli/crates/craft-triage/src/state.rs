//! A triage run's state between steps, kept in `state.json` in its run directory: its arguments,
//! every task it handed out with what its answer said, and the scopes git observed for the
//! memory's records. Nothing derived is kept: each step derives it again ([`crate::run`]).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use craft_review::memory::{PriorDecision, Scope, git_scope};
use serde::{Deserialize, Serialize};

use crate::kind::TriageKind;
use crate::run::{Args, Phase};

/// The state file's format; a run another format wrote is refused, not misread.
pub const STATE_VERSION: u32 = 1;

/// One task of a triage run ([`craft_step::Task`]).
pub type Task = craft_step::Task<TriageKind>;

/// Why a run's state could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum StateError {
    #[error("reading the triage state {}", path.display())]
    Unreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("parsing the triage state {}", path.display())]
    Malformed {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error(
        "the triage state {} is of format {found}; this craft reads format {STATE_VERSION} only: start a new triage",
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

/// What git observed of the records' scopes, each record checked once: those whose scope is
/// unchanged since their commit, and those whose commit the repository lacks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Seen {
    pub checked: BTreeSet<String>,
    pub unchanged: BTreeSet<String>,
    pub missing: BTreeSet<String>,
}

impl Seen {
    /// The scope of `ds`, git in `repo` asked only about the records not checked before.
    pub fn scope(&mut self, repo: &Path, ds: &[&PriorDecision]) -> Scope {
        let fresh: Vec<&PriorDecision> = ds
            .iter()
            .copied()
            .filter(|d| !self.checked.contains(&d.id))
            .collect();
        if !fresh.is_empty() {
            let s = git_scope(repo)(&fresh);
            self.checked.extend(fresh.iter().map(|d| d.id.clone()));
            self.unchanged.extend(s.unchanged);
            self.missing.extend(s.missing);
        }
        let of = |set: &BTreeSet<String>| {
            ds.iter()
                .filter(|d| set.contains(&d.id))
                .map(|d| d.id.clone())
                .collect()
        };
        Scope {
            unchanged: of(&self.unchanged),
            missing: of(&self.missing),
        }
    }
}

/// A triage run between steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriageState {
    pub version: u32,
    /// The repository the run reads: its agents' code, git's scope checks.
    pub cwd: PathBuf,
    pub args: Args,
    pub phase: Phase,
    /// Every task handed out, in order; the pending ones are the current phase's.
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub seen: Seen,
    /// How the host ran tasks weaker than asked, each note once.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub degraded: Vec<String>,
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
pub fn load(dir: &Path) -> Result<TriageState, StateError> {
    let path = state_path(dir);
    let text = std::fs::read_to_string(&path).map_err(|source| StateError::Unreadable {
        path: path.clone(),
        source,
    })?;
    let state: TriageState =
        serde_json::from_str(&text).map_err(|source| StateError::Malformed {
            path: path.clone(),
            source,
        })?;
    if state.version != STATE_VERSION {
        return Err(StateError::Version {
            path,
            found: state.version,
        });
    }
    Ok(state)
}

/// Writes the run's state into `dir`, whole or not at all.
///
/// # Errors
/// When it cannot be encoded or written.
pub fn save(dir: &Path, state: &TriageState) -> Result<(), StateError> {
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
