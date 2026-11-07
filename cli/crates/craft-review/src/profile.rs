//! A language profile as data: `content/profiles/<id>.json` names its lenses (each with its brief,
//! model and flags), its scout rules and its rubric, as `PROFILES` in `lib/review-profiles.mjs`
//! does for the engines; `lib/review-profile-parity.test.mjs` holds the two to one roster. Beside
//! the engines' Rust and Nix profiles the CLI has `general`, adversarial-review's lenses over every
//! file carrying code that neither takes (realm @nick/craft, node #421).

use serde::Deserialize;

use crate::agent::{AgentKind, Model};
use crate::content::{self, ContentError};

/// The profiles a run may review with, in the order a changed file is offered to them.
pub const IDS: [&str; 3] = ["rust", "nix", "general"];

/// What files a profile reviews: a changed path ending in one of `suffixes` or named one of `names`;
/// with `rest`, every file carrying code no other profile takes, project configuration aside.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Detect {
    pub suffixes: Vec<String>,
    pub names: Vec<String>,
    #[serde(default)]
    pub rest: bool,
}

/// What the negative-space lens of a profile inventories as new surface, and the uses of it it
/// greps the unchanged tree for.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NegativeSpace {
    pub new_surface: String,
    pub shape_uses: String,
}

/// Where a lens reads its catalogue, and the classes its brief carries when none is readable.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Catalogue {
    pub label: String,
    pub file: String,
    pub fallback: String,
}

/// One lens of a profile.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lens {
    pub id: String,
    /// Its brief, `content/prompts/<brief>.md`.
    pub brief: String,
    pub model: Model,
    /// In the optional pass: admitted only on an explicit request.
    #[serde(default)]
    pub optional: bool,
    /// Admitted by a code signal, never by a blanket fill.
    #[serde(default)]
    pub conditional: bool,
    /// Reviews the whole diff: a light pass skips it unless the diff calls for it.
    #[serde(default)]
    pub whole_diff: bool,
    /// The scout surface that, said absent, drops it.
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub catalogue: Option<Catalogue>,
}

/// A language profile.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub lang: String,
    pub detect: Detect,
    pub diff_globs: Vec<String>,
    pub rubric_skill: String,
    pub fp_rules: String,
    pub nav_skill: String,
    pub security_hints: String,
    pub uses_library: bool,
    pub always_lenses: Vec<String>,
    pub safety_lens: String,
    /// The scout's rules, `content/prompts/<scoutRules>.md`.
    pub scout_rules: String,
    pub scout_model: Model,
    pub dedup_model: Model,
    /// The agent its lens tasks run on, named without a host's prefix (`rust-reviewer`): each host's
    /// driver maps it to its own agent type. Absent, they run on the host's default agent.
    #[serde(default)]
    pub lens_agent: Option<AgentKind>,
    pub rollup_rule_ids: Vec<String>,
    /// What its negative-space lens looks for; a profile without that lens has none.
    #[serde(default)]
    pub negative_space: Option<NegativeSpace>,
    /// The roster a scout picks from.
    pub lenses: Vec<Lens>,
    /// Lenses only a rigor floor adds, outside the roster.
    pub floor_lenses: Vec<Lens>,
}

impl Profile {
    /// The Rust profile.
    ///
    /// # Errors
    /// When the profile file is missing or not of this shape.
    pub fn rust() -> Result<Self, ContentError> {
        Self::load("rust")
    }

    /// The profile `id`, `content/profiles/<id>.json`.
    ///
    /// # Errors
    /// When the profile file is missing or not of this shape.
    pub fn load(id: &str) -> Result<Self, ContentError> {
        let path = format!("profiles/{id}.json");
        serde_json::from_str(content::raw(&path)?)
            .map_err(|e| ContentError::NotJson(path, e.to_string()))
    }

    /// Every profile of [`IDS`], in its order.
    ///
    /// # Errors
    /// As [`Profile::load`].
    pub fn all() -> Result<Vec<Self>, ContentError> {
        IDS.iter().map(|id| Self::load(id)).collect()
    }

    /// The roster's lens ids, in order.
    #[must_use]
    pub fn roster(&self) -> Vec<String> {
        self.lenses.iter().map(|l| l.id.clone()).collect()
    }

    /// Whether the roster offers `id`.
    #[must_use]
    pub fn offers(&self, id: &str) -> bool {
        self.lenses.iter().any(|l| l.id == id)
    }

    /// The lens `id`, of the roster or a floor.
    #[must_use]
    pub fn lens(&self, id: &str) -> Option<&Lens> {
        self.lenses
            .iter()
            .chain(&self.floor_lenses)
            .find(|l| l.id == id)
    }

    /// The ids of the lenses `flag` holds for, roster and floors, in order.
    #[must_use]
    pub fn flagged(&self, flag: impl Fn(&Lens) -> bool) -> Vec<String> {
        self.lenses
            .iter()
            .chain(&self.floor_lenses)
            .filter(|l| flag(l))
            .map(|l| l.id.clone())
            .collect()
    }

    /// Whether the profile reviews any of `files`.
    #[must_use]
    pub fn detects(&self, files: &[String]) -> bool {
        files.iter().any(|f| self.covers(f))
    }

    /// Whether the profile reviews `file`: by its suffixes and names, or, a profile taking the
    /// rest, when it carries code and is no project configuration. Which of several profiles takes
    /// a file is [`crate::coverage::assign`]'s.
    #[must_use]
    pub fn covers(&self, file: &str) -> bool {
        if self.detect.rest {
            return !crate::coverage::is_inert(file) && !crate::coverage::is_ancillary(file);
        }
        let base = file.rsplit('/').next().unwrap_or(file);
        self.detect
            .suffixes
            .iter()
            .any(|s| file.ends_with(s.as_str()))
            || self.detect.names.iter().any(|n| n == base)
    }

    /// What a `git diff` of this profile's part of a change names: its globs, or, a profile
    /// without any, the files it took, each a literal pathspec.
    #[must_use]
    pub fn pathspec(&self, files: &[String]) -> String {
        if !self.diff_globs.is_empty() {
            return self.diff_globs.join(" ");
        }
        files
            .iter()
            .filter(|f| !f.is_empty())
            .map(|f| format!("'{}'", format!(":(literal){f}").replace('\'', r"'\''")))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[cfg(test)]
mod tests;
