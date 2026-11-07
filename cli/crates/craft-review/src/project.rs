//! The reviewer's project profile (realm @nick/craft, node #467): `review.toml` under
//! `~/.craft/projects/<id>/`, one per repository, kept by each reviewer and never in the
//! project's own tree. `craft init` writes it; `craft review start` reads it. It holds the
//! integration points — the external systems the project's code talks to over the network or
//! through their API — each with its source and the revision that counts as deployed (a tag or a
//! full commit, never a branch: node #430). Unknown keys are left for later sections (lens
//! overrides, say), so an older binary reads a newer profile's integration points.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::git;
use crate::sources::spec::SYSTEMS_MAX;

mod point;
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
}

impl ProjectProfile {
    /// A profile of `repo` holding `points`, each checked, their names unique, at most
    /// [`SYSTEMS_MAX`].
    ///
    /// # Errors
    /// The first point that fails, or too many, or a name twice.
    pub fn new(repo: String, integrations: Vec<IntegrationPoint>) -> Result<Self, ProjectError> {
        let p = Self {
            version: PROFILE_VERSION,
            repo,
            integrations,
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

/// Writes `profile` to `path` whole: a sibling file renamed into place.
///
/// # Errors
/// When the directory or the file cannot be written.
pub fn save(path: &Path, profile: &ProjectProfile) -> Result<(), ProjectError> {
    let write = |source| ProjectError::Write {
        path: path.to_owned(),
        source,
    };
    let body = toml::to_string(profile).map_err(|e| ProjectError::Invalid(e.to_string()))?;
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
