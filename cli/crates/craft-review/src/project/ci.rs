//! One entry of the profile's CI map (realm @nick/craft, node #482): a check as GitHub reports it,
//! the signal it carries, the command line that coverage rests on, and the workflow that runs it
//! with that file's hash when it was confirmed. The reviewer confirms each entry in words (node
//! #483); a bare check name is never coverage, so an entry's command must name the signal's cargo
//! command itself. The gate reads the map only when its own build is impossible, and skips an
//! entry whose workflow changed since.

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::shell::signals_in;
pub use super::signal::Signal;

/// At most this many entries.
pub const CI_MAX: usize = 32;

/// One confirmed check of the CI map.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CiEntry {
    /// The check-run name or commit-status context as GitHub reports it; a matrix job's
    /// `<check> (…)` runs count as it too.
    pub check: String,
    pub signal: Signal,
    /// The command line the coverage rests on, as the workflow or its recipe spells it.
    pub command: String,
    /// The workflow file, repository-relative.
    pub workflow: String,
    /// The SHA-256 of the workflow file when the entry was written, hex.
    pub workflow_hash: String,
}

/// What `craft init --write --ci` is handed for one entry: the hash is the binary's to compute.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Confirmed {
    check: String,
    signal: Signal,
    command: String,
    workflow: String,
}

/// The SHA-256 of `workflow` under `top`, hex.
///
/// # Errors
/// When it cannot be read.
pub fn workflow_hash(top: &Path, workflow: &str) -> std::io::Result<String> {
    let bytes = std::fs::read(top.join(workflow))?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

impl CiEntry {
    /// An entry from its confirmed JSON (`check`, `signal`, `command`, `workflow`), the workflow's
    /// hash read under `top` now, then checked.
    ///
    /// # Errors
    /// Why it is not one, a line for the reviewer.
    pub fn confirmed(json: &str, top: &Path) -> Result<Self, String> {
        let c: Confirmed = serde_json::from_str(json).map_err(|e| {
            format!("{json:?} is not {{\"check\",\"signal\",\"command\",\"workflow\"}}: {e}")
        })?;
        relative(&c.workflow)?;
        let workflow_hash = workflow_hash(top, &c.workflow)
            .map_err(|e| format!("{}: cannot be read: {e}", c.workflow))?;
        let e = Self {
            check: c.check.trim().into(),
            signal: c.signal,
            command: c.command.trim().into(),
            workflow: c.workflow,
            workflow_hash,
        };
        e.check().map(|()| e)
    }

    /// Whether the entry is one the gate can read.
    ///
    /// # Errors
    /// Why not, naming the check.
    pub fn check(&self) -> Result<(), String> {
        let at = &self.check;
        let line = |s: &str| !s.is_empty() && s.len() <= 300 && !s.contains(['\n', '\r']);
        if !line(at) {
            return Err(format!("{at:?}: a check is one non-empty line"));
        }
        if !line(&self.command) || !signals_in(&self.command).contains(&self.signal) {
            return Err(format!(
                "{at}: the command {:?} does not run `cargo {}` — quote the command line the check runs",
                self.command,
                self.signal.as_str()
            ));
        }
        relative(&self.workflow).map_err(|e| format!("{at}: {e}"))?;
        let hex = self.workflow_hash.len() == 64
            && self.workflow_hash.bytes().all(|b| b.is_ascii_hexdigit());
        if hex {
            Ok(())
        } else {
            Err(format!("{at}: the workflow hash is no SHA-256"))
        }
    }

    /// Whether its workflow under `top` is still the file it was confirmed from.
    #[must_use]
    pub fn fresh(&self, top: &Path) -> bool {
        workflow_hash(top, &self.workflow).is_ok_and(|h| h == self.workflow_hash)
    }
}

/// Refuses a workflow path that is absolute or climbs out of the repository.
fn relative(workflow: &str) -> Result<(), String> {
    let p = Path::new(workflow);
    let inside = !workflow.is_empty()
        && p.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if inside {
        Ok(())
    } else {
        Err(format!(
            "{workflow:?}: a workflow is a path inside the repository"
        ))
    }
}
