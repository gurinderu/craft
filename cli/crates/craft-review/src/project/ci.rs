//! One entry of the profile's CI map (realm @nick/craft, node #482): a check as GitHub reports it,
//! the signal it carries, the command line that coverage rests on, the workflow that runs it, the
//! recipes and local actions the command goes through, and each file's hash when it was confirmed.
//! The reviewer confirms each entry in words (node #483); a bare check name is never coverage, so
//! an entry's command must name the signal's cargo command itself. The gate reads the map only when
//! its own build is impossible, and skips an entry one of whose files changed since.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub use super::ci_error::CiError;
pub use super::ci_files::local_file;
use super::ci_files::{changed, hashes, local_uses_listed, relative};
use super::shell::signals_in;
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
    /// each source, and the cargo config when there was one — by path.
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
    /// An entry from its JSON, then checked: a fresh confirmation's files are hashed under `top`
    /// now, after each local `uses:` of its workflow is found among its sources; a held one keeps
    /// the hashes it carries.
    ///
    /// # Errors
    /// Why it is not one, a line for the reviewer.
    pub fn confirmed(json: &str, top: &Path) -> Result<Self, CiError> {
        let g: Given = serde_json::from_str(json).map_err(|e| CiError::Shape {
            given: json.to_owned(),
            why: e.to_string(),
        })?;
        let check = g.check.trim().to_owned();
        let recorded = match g.hashes {
            Some(h) => h,
            None => {
                relative(&g.workflow)?;
                g.sources.iter().try_for_each(|s| relative(s))?;
                local_uses_listed(top, &g.workflow, &check, &g.sources)?;
                let files: Vec<&str> = std::iter::once(g.workflow.as_str())
                    .chain(g.sources.iter().map(String::as_str))
                    .collect();
                hashes(top, &files)?
            }
        };
        let e = Self {
            check,
            signal: g.signal,
            command: g.command.trim().into(),
            workflow: g.workflow,
            sources: g.sources,
            hashes: recorded,
        };
        e.check().map(|()| e)
    }

    /// Whether the entry is one the gate can read: its files inside the repository, each hashed.
    ///
    /// # Errors
    /// Why not, naming the check.
    pub fn check(&self) -> Result<(), CiError> {
        let at = &self.check;
        let line = |s: &str| !s.is_empty() && s.len() <= 300 && !s.contains(['\n', '\r']);
        if !line(at) {
            return Err(CiError::Check(at.clone()));
        }
        if !line(&self.command) || !signals_in(&self.command).contains(&self.signal) {
            return Err(CiError::Command {
                check: at.clone(),
                command: self.command.clone(),
                signal: self.signal.as_str(),
            });
        }
        self.hashes.keys().try_for_each(|p| relative(p))?;
        let hex = |h: &String| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit());
        let files = std::iter::once(&self.workflow).chain(&self.sources);
        for f in files {
            relative(f)?;
            if !self.hashes.get(f).is_some_and(hex) {
                return Err(CiError::Hash {
                    check: at.clone(),
                    path: f.clone(),
                });
            }
        }
        match self.hashes.iter().find(|(_, h)| !hex(h)) {
            Some((p, _)) => Err(CiError::Hash {
                check: at.clone(),
                path: p.clone(),
            }),
            None => Ok(()),
        }
    }

    /// The files under `top` that are no longer the ones the entry was confirmed from, a cargo
    /// config that appeared since included.
    #[must_use]
    pub fn changed(&self, top: &Path) -> Vec<String> {
        changed(top, &self.hashes)
    }

    /// Whether every file the entry rests on is still the one it was confirmed from.
    #[must_use]
    pub fn fresh(&self, top: &Path) -> bool {
        self.changed(top).is_empty()
    }
}
