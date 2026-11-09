//! The reviewer's project profile (realm @nick/craft, node #467): `review.toml` under
//! `~/.craft/projects/<id>/`, one per repository, kept by each reviewer and never in the
//! project's own tree. `craft init` writes it; `craft review start` reads it. It holds the
//! integration points — the external systems the project's code talks to over the network or
//! through their API — each with its source and the revision that counts as deployed (a tag or a
//! full commit, never a branch: node #430), and the CI map — which check of the project's CI
//! carries which signal, on which command line (node #482), the gate's evidence when it cannot
//! build the head itself. Unknown keys are left for later sections (lens overrides, say), so an
//! older binary reads a newer profile's integration points.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::git;
use crate::sources::spec::SYSTEMS_MAX;

pub mod candidates;
pub mod ci;
mod ci_error;
mod ci_files;
#[cfg(test)]
mod ci_files_tests;
#[cfg(test)]
mod ci_tests;
mod point;
mod shell;
mod signal;
pub mod workflow;
#[cfg(test)]
mod workflow_tests;
pub use ci::{CI_MAX, CiEntry, CiError, Signal};
pub use point::IntegrationPoint;

/// The profile's format; a profile of another is refused, not misread.
pub const PROFILE_VERSION: u32 = 1;
/// The profile's file name in its project directory.
const FILE: &str = "review.toml";

/// Why a profile could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("reading {}", path.display())]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{} is not a review profile: {why}", path.display())]
    Malformed { path: PathBuf, why: String },
    #[error("writing {}", path.display())]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{0}")]
    Invalid(String),
}

/// The reviewer's profile of one repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectProfile {
    pub version: u32,
    /// The repository's shared git directory it was written for, for the reader.
    #[serde(default)]
    pub repo: String,
    #[serde(default, rename = "integration")]
    pub integrations: Vec<IntegrationPoint>,
    /// The CI map: always written, an empty one too, so a write replaces the one it held.
    #[serde(default)]
    pub ci: Vec<CiEntry>,
}

impl ProjectProfile {
    /// A profile of `repo` holding `points`, each checked, their names unique, at most
    /// [`SYSTEMS_MAX`], and the CI map `ci`, at most [`CI_MAX`] entries, no check's signal twice.
    ///
    /// # Errors
    /// The first point or entry that fails, or too many, or one twice.
    pub fn new(
        repo: String,
        integrations: Vec<IntegrationPoint>,
        ci: Vec<CiEntry>,
    ) -> Result<Self, ProjectError> {
        let p = Self {
            version: PROFILE_VERSION,
            repo,
            integrations,
            ci,
        };
        p.check().map_err(ProjectError::Invalid)?;
        Ok(p)
    }

    fn check(&self) -> Result<(), String> {
        if self.version != PROFILE_VERSION {
            return Err(format!("format {} is not {PROFILE_VERSION}", self.version));
        }
        if self.integrations.len() > SYSTEMS_MAX {
            return Err(format!("more than {SYSTEMS_MAX} integration points"));
        }
        for (i, p) in self.integrations.iter().enumerate() {
            p.check()?;
            if self.integrations.iter().take(i).any(|q| q.name == p.name) {
                return Err(format!("{}: named twice", p.name));
            }
        }
        if self.ci.len() > CI_MAX {
            return Err(format!("more than {CI_MAX} CI map entries"));
        }
        for (i, e) in self.ci.iter().enumerate() {
            e.check().map_err(|e| e.to_string())?;
            let twice = |f: &CiEntry| f.check == e.check && f.signal == e.signal;
            if self.ci.iter().take(i).any(twice) {
                return Err(format!(
                    "{}: its {} signal named twice",
                    e.check,
                    e.signal.as_str()
                ));
            }
        }
        Ok(())
    }
}

/// The repository's key: its shared git directory's last name, slugged, and a hash of the whole
/// path, so every worktree of one clone shares one profile and two clones of one name do not.
#[must_use]
pub fn project_id(common_dir: &str) -> String {
    let p = Path::new(common_dir);
    let named = match p.file_name().and_then(|n| n.to_str()) {
        Some(".git") => p.parent().and_then(Path::file_name),
        Some(_) | None => p.file_name(),
    };
    let name = named.map(|n| n.to_string_lossy()).unwrap_or_default();
    let slug: String = name
        .trim_end_matches(".git")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(40)
        .collect();
    let hash = Sha256::digest(common_dir.as_bytes());
    let hex: String = hash.iter().take(6).map(|b| format!("{b:02x}")).collect();
    format!("{}-{hex}", if slug.is_empty() { "repo" } else { &slug })
}

/// Where the profile of the repository at `cwd` lives under `projects` (`~/.craft/projects`), and
/// that repository's shared git directory.
///
/// # Errors
/// When `cwd` is no repository.
pub fn profile_path(projects: &Path, cwd: &Path) -> Result<(PathBuf, String), git::GitError> {
    let common = git::common_dir(cwd)?;
    Ok((projects.join(project_id(&common)).join(FILE), common))
}

/// The profile at `path`, `None` when there is none.
///
/// # Errors
/// When it cannot be read, is not TOML of this format, or a point fails its check.
pub fn load(path: &Path) -> Result<Option<ProjectProfile>, ProjectError> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(ProjectError::Read {
                path: path.to_owned(),
                source,
            });
        }
    };
    let malformed = |why: String| ProjectError::Malformed {
        path: path.to_owned(),
        why,
    };
    let p: ProjectProfile = toml::from_str(&text).map_err(|e| malformed(e.message().into()))?;
    p.check().map_err(malformed)?;
    Ok(Some(p))
}

/// What the profile at `path` holds now, as TOML: empty when there is none. A section this binary
/// does not know (a later format's) is kept on a write.
fn kept(path: &Path) -> Result<toml::Table, ProjectError> {
    match std::fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).map_err(|e| ProjectError::Malformed {
            path: path.to_owned(),
            why: format!("{} — fix or remove it before writing", e.message()),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(toml::Table::new()),
        Err(source) => Err(ProjectError::Read {
            path: path.to_owned(),
            source,
        }),
    }
}

/// Refuses to write over a stored profile of another format: its sections are kept on a write,
/// and stamping them with this binary's version would claim a format they may not have.
fn same_format(path: &Path, table: &toml::Table) -> Result<(), ProjectError> {
    if table.is_empty() {
        return Ok(());
    }
    match table.get("version").and_then(toml::Value::as_integer) {
        Some(v) if v == i64::from(PROFILE_VERSION) => Ok(()),
        found => Err(ProjectError::Malformed {
            path: path.to_owned(),
            why: format!(
                "it is format {}, this craft writes {PROFILE_VERSION} — nothing written: use a craft that reads it, or remove the file",
                found.map_or_else(|| "unknown".to_owned(), |v| v.to_string())
            ),
        }),
    }
}

/// Writes `profile` to `path`, the sections it does not know kept: a sibling file renamed into
/// place.
///
/// # Errors
/// When the profile there is not TOML or is of another format, or the directory or the file
/// cannot be written.
pub fn save(path: &Path, profile: &ProjectProfile) -> Result<(), ProjectError> {
    let write = |source| ProjectError::Write {
        path: path.to_owned(),
        source,
    };
    let invalid = |e: &dyn std::fmt::Display| ProjectError::Invalid(e.to_string());
    let mut table = kept(path)?;
    same_format(path, &table)?;
    table.extend(toml::Table::try_from(profile).map_err(|e| invalid(&e))?);
    let body = toml::to_string(&table).map_err(|e| invalid(&e))?;
    let text = format!(
        "# craft's review profile for one repository, kept by its reviewer (`craft init`); never \
         commit it to the project.\n{body}"
    );
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(write)?;
    }
    let tmp = path.with_extension(format!("toml.tmp-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(write)?;
    std::fs::rename(&tmp, path).map_err(write)
}

#[cfg(test)]
mod tests;
