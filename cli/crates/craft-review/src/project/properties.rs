//! The profile's `[project]` section (realm @nick/craft, node #654): what the reviewer confirmed of
//! the project itself, which no diff changes — whether it is a published library, its rule files,
//! whether it holds controllers, the paths where security lives and its contract files. A fact
//! (`library`, `rules`) is taken over the scout's answer either way; a risk (`controllers`,
//! `security_paths`, `contracts`) only adds to what the scout saw, never takes from it.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub use super::section::SectionError;

/// The section as the reviewer confirmed it; each field absent when not confirmed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Properties {
    /// A published library (semver matters to its users); the scout's guess when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library: Option<bool>,
    /// The repository's own rule files, repository-relative; the scout's when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<String>>,
    /// It holds controllers or reconcile loops: the reconciler lens runs on every change.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub controllers: bool,
    /// Where security lives: a change touching one is security-sensitive.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub security_paths: Vec<String>,
    /// Its contract files beside those craft knows: a change touching one takes the compat lens.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contracts: Vec<String>,
}

/// No property confirmed: the plan reads the scout's answer alone, as before the section.
pub static NONE: Properties = Properties::new();

impl Properties {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            library: None,
            rules: None,
            controllers: false,
            security_paths: Vec::new(),
            contracts: Vec::new(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self == &NONE
    }

    /// Whether the change's file `f` is under one of the security paths.
    #[must_use]
    pub fn security(&self, f: &str) -> bool {
        self.security_paths.iter().any(|p| under(p, f))
    }

    /// Whether the change's file `f` is one of the contract files.
    #[must_use]
    pub fn contract(&self, f: &str) -> bool {
        self.contracts.iter().any(|p| under(p, f))
    }

    /// The line the report says of what the profile set; `None` when it set nothing.
    #[must_use]
    pub fn line(&self) -> Option<String> {
        let mut parts = Vec::new();
        if let Some(l) = self.library {
            parts.push(format!("library: {}", if l { "yes" } else { "no" }));
        }
        if let Some(r) = &self.rules {
            parts.push(format!(
                "rule files: {}",
                if r.is_empty() {
                    "none".into()
                } else {
                    r.join(", ")
                }
            ));
        }
        if self.controllers {
            parts.push("controllers: yes".into());
        }
        if !self.security_paths.is_empty() {
            parts.push(format!(
                "security paths: {}",
                self.security_paths.join(", ")
            ));
        }
        if !self.contracts.is_empty() {
            parts.push(format!("contracts: {}", self.contracts.join(", ")));
        }
        (!parts.is_empty()).then(|| {
            format!(
                "the reviewer's profile sets the project's properties — {}",
                parts.join("; ")
            )
        })
    }
}

/// Whether `f` matches the pattern `p`: a Cargo-style glob, or a path naming `f` or a directory
/// above it.
fn under(p: &str, f: &str) -> bool {
    let p = p.trim_end_matches('/');
    crate::design::members::glob(p, f)
        || f.strip_prefix(p).is_some_and(|rest| rest.starts_with('/'))
}

/// The `[project]` section of the profile at `path`: none confirmed when the profile or the
/// section is absent.
///
/// # Errors
/// When the profile cannot be read, is not TOML, or the section is not of this shape.
pub fn of(path: &Path) -> Result<Properties, SectionError> {
    super::section::of(path, "project").map(Option::unwrap_or_default)
}

#[cfg(test)]
mod tests;
