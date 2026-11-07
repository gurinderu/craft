//! The review's external sources (realm @nick/craft, node #430, the profile of node #467): the
//! source of each integration point the reviewer's profile names, at the revision it deploys,
//! fetched once into the sources cache by the binary itself — the step the engine gives a service
//! agent and `lib/craft-source.mjs` (node #432). The directories reach the lenses that judge
//! another system's behaviour and every verifier as an EXTERNAL SOURCES block ([`text`]), and the
//! report says what was prepared and what was not: a system that could not be is reviewed without
//! its context, and the review goes on.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::project::{self, IntegrationPoint};

mod fetch;
mod runner;
pub mod spec;
#[cfg(test)]
mod tests;
mod text;

pub use runner::Git;
pub use text::{lens_block, reads, section, verify_block};

/// A system's source in the cache.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prepared {
    pub system: String,
    /// The revision fetched: the profile's, or its `v` spelling the remote tags.
    #[serde(rename = "ref")]
    pub rev: String,
    pub dir: String,
}

/// A system whose source could not be prepared, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failed {
    pub system: String,
    pub error: String,
}

/// What a run's preparation came to. Every field optional, so a state written before it reads as
/// a run with no integration points.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sources {
    /// Every integration point the profile names, prepared or not.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub systems: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prepared: Vec<Prepared>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed: Vec<Failed>,
    /// Why the cache could not be used at all.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub unreachable: String,
    /// Why the profile could not be read.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub skipped: String,
}

impl Sources {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// Where a run finds its integration points and puts their sources.
#[derive(Debug, Clone)]
pub struct SourcesSetup {
    /// The reviewers' profiles, `~/.craft/projects`.
    pub projects: PathBuf,
    /// The cache, `$CRAFT_SOURCES_DIR` or `~/.craft/sources`; `Err` names why there is none.
    pub cache: Result<PathBuf, String>,
    pub git: Git,
}

/// The cache root `CRAFT_SOURCES_DIR` names, else `<home>/.craft/sources` (`sourcesRoot`).
///
/// # Errors
/// When the variable is set but not absolute, or neither it nor a home is there.
pub fn cache_root(set: Option<&str>, home: Option<&Path>) -> Result<PathBuf, String> {
    match (set.filter(|s| !s.is_empty()), home) {
        (Some(s), _) if Path::new(s).is_absolute() => Ok(PathBuf::from(s)),
        (Some(s), _) => Err(format!("CRAFT_SOURCES_DIR is not absolute: {s}")),
        (None, Some(h)) => Ok(h.join(".craft/sources")),
        (None, None) => Err("neither CRAFT_SOURCES_DIR nor HOME is set".into()),
    }
}

/// An error with each of its sources, one line.
fn chain(e: &dyn std::error::Error) -> String {
    let mut s = e.to_string();
    let mut at = e.source();
    while let Some(c) = at {
        s.push_str(&format!(": {c}"));
        at = c.source();
    }
    s
}

/// The sources of the integration points the profile of the repository at `cwd` names; nothing
/// when it has none. A profile that cannot be read is named, and the review goes on without.
#[must_use]
pub fn for_repo(cwd: &Path, setup: &SourcesSetup) -> Sources {
    let loaded = project::profile_path(&setup.projects, cwd)
        .map_err(|e| chain(&e))
        .and_then(|(path, _)| project::load(&path).map_err(|e| chain(&e)));
    match loaded {
        Ok(Some(p)) => prepare(
            &p.integrations,
            setup.cache.as_deref().map_err(String::as_str),
            &setup.git,
        ),
        Ok(None) => Sources::default(),
        Err(why) => Sources {
            skipped: format!("the review profile could not be read: {why}"),
            ..Sources::default()
        },
    }
}

/// Each point's source in `cache`, or why not, one by one.
#[must_use]
pub fn prepare(points: &[IntegrationPoint], cache: Result<&Path, &str>, git: &Git) -> Sources {
    let mut out = Sources {
        systems: points.iter().map(|p| p.name.clone()).collect(),
        ..Sources::default()
    };
    let root = match cache {
        Ok(r) => r,
        Err(why) => {
            out.unreachable = why.to_owned();
            return out;
        }
    };
    for p in points {
        match prepare_one(p, root, git) {
            Ok((rev, dir)) => out.prepared.push(Prepared {
                system: p.name.clone(),
                rev,
                dir: dir.display().to_string(),
            }),
            Err(error) => out.failed.push(Failed {
                system: p.name.clone(),
                error,
            }),
        }
    }
    out
}

fn prepare_one(p: &IntegrationPoint, root: &Path, git: &Git) -> Result<(String, PathBuf), String> {
    if let Some(why) = spec::ref_fault(&p.rev) {
        return Err(format!("ref: {why}"));
    }
    let parts = spec::repo_parts(&p.repo)?;
    let target_of = |rev: &str| {
        spec::cache_segments(&parts, rev)
            .iter()
            .fold(root.to_path_buf(), |d, s| d.join(s))
    };
    fetch::cached_copy(git, &p.repo, &p.rev, &target_of)
}
