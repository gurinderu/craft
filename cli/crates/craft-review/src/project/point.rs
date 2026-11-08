//! One integration point of the reviewer's profile: a system, its source, its deployed revision.

use serde::{Deserialize, Serialize};

use crate::sources::spec::{is_system_name, ref_fault, repo_parts};

/// One external system the project's code talks to, and where its deployed source is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrationPoint {
    pub name: String,
    /// The git URL of the system's source.
    pub repo: String,
    /// The tag or full commit that counts as deployed.
    #[serde(rename = "ref")]
    pub rev: String,
}

impl IntegrationPoint {
    /// Reads `name=<git url>@<tag or commit>`, split at the last `@` (a revision holds none, an
    /// ssh URL may), then checked.
    ///
    /// # Errors
    /// Why it is not one, a line for the reviewer.
    pub fn parse(s: &str) -> Result<Self, String> {
        let (name, rest) = s
            .split_once('=')
            .ok_or_else(|| format!("{s:?} is not name=<git url>@<tag or commit>"))?;
        let (repo, rev) = rest
            .rsplit_once('@')
            .ok_or_else(|| format!("{s:?} names no revision after an @"))?;
        let p = Self {
            name: name.trim().into(),
            repo: repo.trim().into(),
            rev: rev.trim().into(),
        };
        p.check().map(|()| p)
    }

    /// Whether the point is one the preparation can fetch: a system name, a cloneable URL, a
    /// revision in the safe charset (whether it is a tag, a commit or a branch only the remote
    /// tells; a branch is refused when the sources are prepared).
    ///
    /// # Errors
    /// Why not, naming the point.
    pub fn check(&self) -> Result<(), String> {
        let at = &self.name;
        if !is_system_name(at) {
            return Err(format!(
                "{at:?}: a name is letters, digits, \".\", \"_\" or \"-\""
            ));
        }
        repo_parts(&self.repo).map_err(|e| format!("{at}: {e}"))?;
        match ref_fault(&self.rev) {
            Some(why) => Err(format!("{at}: {why}")),
            None => Ok(()),
        }
    }
}
