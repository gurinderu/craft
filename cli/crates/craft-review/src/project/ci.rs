//! One entry of the profile's CI map (realm @nick/craft, node #482): a check as GitHub reports it,
//! the signal it carries, the command line that coverage rests on, the workflow that runs it, the
//! recipes and local actions the command goes through, and each file's hash when it was confirmed.
//! The reviewer confirms each entry in words (node #483); a bare check name is never coverage, so
//! an entry's command must name the signal's cargo command itself and be found in its job or one of
//! its sources. The gate reads the map only when its own build is impossible, and skips an entry
//! one of whose files changed since or whose command is no longer found in them.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::check_claim::claimed;
pub use super::check_name::unexpanded;
pub use super::ci_error::CiError;
use super::ci_files::changed;
pub use super::ci_files::local_file;
use super::ci_ground::grounded;
pub use super::signal::Signal;

/// At most this many entries.
pub const CI_MAX: usize = 32;

/// One confirmed check of the CI map; its JSON is what `craft init --write --ci` takes back.
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
    /// The files beyond the workflow the command goes through — a justfile, a Makefile, an xtask,
    /// a script, a local action — repository-relative.
    #[serde(default)]
    pub sources: Vec<String>,
    /// The SHA-256, hex, of each file the coverage rests on when it was confirmed — the workflow,
    /// each source, and each cargo config its jobs' directories read — by path.
    pub hashes: BTreeMap<String, String>,
}

/// What `craft init --write --ci` is handed for one entry: without `hashes` a fresh confirmation,
/// hashed at the write; with them the held form, kept as recorded so a stale entry stays stale.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Given {
    check: String,
    signal: Signal,
    command: String,
    workflow: String,
    #[serde(default)]
    sources: Vec<String>,
    hashes: Option<BTreeMap<String, String>>,
}

impl CiEntry {
    /// An entry from its JSON, then checked: a fresh confirmation's command and local `uses:` are
    /// found in its workflow and sources under `top`, and its files hashed now; a held one keeps
    /// the hashes it carries and is found the same while its files are the ones hashed — once one
    /// changed it is stale, and [`Self::fresh`] finds it again before the gate trusts it.
    ///
    /// # Errors
    /// Why it is not one, a line for the reviewer.
    pub fn confirmed(json: &str, top: &Path) -> Result<Self, CiError> {
        let g: Given = serde_json::from_str(json).map_err(|e| CiError::Shape {
            given: json.to_owned(),
            why: e.to_string(),
        })?;
        let held = g.hashes.is_some();
        Self {
            check: g.check.trim().to_owned(),
            signal: g.signal,
            command: g.command.trim().into(),
            workflow: g.workflow,
            sources: g.sources,
            hashes: g.hashes.unwrap_or_default(),
        }
        .checked(top, held)
    }

    /// Whether it may be written: its check claims no other job's runs nor one expanded run of
    /// its own, and it is [grounded](Self::grounded).
    pub(super) fn written(&self, top: &Path) -> Result<(), CiError> {
        self.claims(top)?;
        self.grounded(top)
    }

    /// Whether its check claims no other job's runs, in any workflow under `top`, nor one expanded
    /// run of a job.
    ///
    /// # Errors
    /// The job it collides with or names one run of, a line for the reviewer.
    pub fn claims(&self, top: &Path) -> Result<(), CiError> {
        claimed(top, &self.workflow, &self.check, &self.command)
    }

    /// Whether its command and local `uses:` are found in its workflow and sources under `top`.
    fn grounded(&self, top: &Path) -> Result<(), CiError> {
        grounded(
            top,
            &self.workflow,
            &self.check,
            &self.command,
            &self.sources,
        )
    }

    /// The files under `top` that are no longer the ones the entry was confirmed from, a cargo
    /// config its jobs read that appeared since included.
    #[must_use]
    pub fn changed(&self, top: &Path) -> Vec<String> {
        changed(top, &self.workflow, &self.hashes)
    }

    /// Why the entry's command or local `uses:` is not found in its files under `top`, if so.
    #[must_use]
    pub fn unfound(&self, top: &Path) -> Option<String> {
        self.grounded(top).err().map(|e| e.to_string())
    }

    /// Whether every file the entry rests on is still the one it was confirmed from, and its
    /// command and local `uses:` are found in them.
    #[must_use]
    pub fn fresh(&self, top: &Path) -> bool {
        self.changed(top).is_empty() && self.unfound(top).is_none()
    }
}
