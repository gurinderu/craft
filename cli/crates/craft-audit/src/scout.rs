//! What the audit reads: the project's git-tracked files (only those under the `--path`s given),
//! each routed to the language profile the review of a diff would give it
//! ([`craft_review::coverage::assign`]) and cut into batches ([`crate::batch`]). A tracked file no
//! profile takes — project configuration, prose, an image — is outside the audit and counted as
//! such; one the working tree does not hold as a regular file (deleted, a symlink) is not listed.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;

use craft_review::profile::Profile;
use serde::{Deserialize, Serialize};

use crate::AuditError;
use crate::batch::{Batch, Tracked, batches};

/// The profiles an audit routes files to, in the order a file is offered to them: those of the
/// review but the runbook's, whose files are taken by a change touching a step.
pub const PROFILES: [&str; 4] = ["rust", "nix", "sql", "general"];

/// One profile's files, in batches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Part {
    pub profile: String,
    pub batches: Vec<Batch>,
}

/// What the scout found.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scouted {
    /// How many tracked files the working tree holds.
    pub tracked: usize,
    pub parts: Vec<Part>,
    /// The tracked files no profile takes.
    pub outside: Vec<String>,
}

impl Scouted {
    /// How many files the audit's profiles took.
    #[must_use]
    pub fn audited(&self) -> usize {
        self.parts
            .iter()
            .flat_map(|p| &p.batches)
            .map(|b| b.files.len())
            .sum()
    }
}

/// The audit's profiles, in [`PROFILES`]' order.
///
/// # Errors
/// When a profile cannot be read.
pub fn profiles() -> Result<Vec<Profile>, AuditError> {
    PROFILES
        .iter()
        .map(|id| Profile::load(id).map_err(AuditError::from))
        .collect()
}

/// The regular files git tracks in the repository at `root` under `paths` (all of them, none
/// given), each with its size, in git's order.
///
/// # Errors
/// [`AuditError::NotGit`] when git cannot list them.
pub fn tracked(root: &Path, paths: &[String]) -> Result<Vec<Tracked>, AuditError> {
    let not_git = |why: String| AuditError::NotGit {
        path: root.to_owned(),
        why,
    };
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z", "--full-name", "--"])
        .args(paths.iter().map(|p| format!(":(literal){p}")))
        .output()
        .map_err(|e| not_git(e.to_string()))?;
    if !out.status.success() {
        return Err(not_git(String::from_utf8_lossy(&out.stderr).trim().into()));
    }
    let listed = String::from_utf8(out.stdout).map_err(|e| not_git(e.to_string()))?;
    Ok(listed
        .split('\0')
        .filter(|p| !p.is_empty())
        .filter_map(|p| {
            let meta = std::fs::symlink_metadata(root.join(p)).ok()?;
            meta.is_file().then(|| Tracked {
                path: p.to_owned(),
                bytes: meta.len(),
            })
        })
        .collect())
}

/// `files` routed to `profiles` and each part cut into batches under `budget` bytes.
#[must_use]
pub fn scout(files: &[Tracked], profiles: &[Profile], budget: u64) -> Scouted {
    let names: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
    let assigned = craft_review::coverage::assign(&names, profiles, &|_| false);
    let sizes: HashMap<&str, u64> = files.iter().map(|f| (f.path.as_str(), f.bytes)).collect();
    let size = |p: &str| sizes.get(p).copied().unwrap_or_default();
    let parts: Vec<Part> = assigned
        .iter()
        .filter_map(|(i, part)| {
            let profile = profiles.get(*i)?;
            let with_sizes: Vec<Tracked> = part
                .iter()
                .map(|p| Tracked {
                    path: p.clone(),
                    bytes: size(p),
                })
                .collect();
            Some(Part {
                profile: profile.id.clone(),
                batches: batches(&with_sizes, budget),
            })
        })
        .collect();
    let taken: HashSet<&String> = assigned.iter().flat_map(|(_, part)| part).collect();
    Scouted {
        tracked: files.len(),
        outside: names
            .iter()
            .filter(|p| !taken.contains(p))
            .cloned()
            .collect(),
        parts,
    }
}

#[cfg(test)]
mod tests;
