//! A language profile as data: `content/profiles/<id>.json` names its lenses (each with its brief,
//! model and flags), its scout rules and its rubric, as `PROFILES` in `lib/review-profiles.mjs`
//! does for the engines; `lib/review-profile-parity.test.mjs` holds the two to one roster.

use serde::Deserialize;

use crate::content::{self, ContentError};

/// What files a profile reviews: a changed path ending in one of `suffixes` or named one of `names`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Detect {
    pub suffixes: Vec<String>,
    pub names: Vec<String>,
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
    pub model: String,
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
    pub scout_model: String,
    pub dedup_model: String,
    pub rollup_rule_ids: Vec<String>,
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
        let path = "profiles/rust.json";
        serde_json::from_str(content::raw(path)?)
            .map_err(|e| ContentError::NotJson(path.to_owned(), e.to_string()))
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

    /// Whether the profile reviews `file`.
    #[must_use]
    pub fn covers(&self, file: &str) -> bool {
        let base = file.rsplit('/').next().unwrap_or(file);
        self.detect
            .suffixes
            .iter()
            .any(|s| file.ends_with(s.as_str()))
            || self.detect.names.iter().any(|n| n == base)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rust_profile_reads_and_every_brief_is_carried() {
        let p = Profile::rust().unwrap();
        assert_eq!(p.id, "rust");
        assert!(p.offers("intent") && !p.offers("negative-space"));
        assert!(p.lens("negative-space").is_some());
        for l in p.lenses.iter().chain(&p.floor_lenses) {
            content::text(&l.brief).unwrap();
        }
        content::text(&p.scout_rules).unwrap();
        assert!(p.covers("a/Cargo.toml") && p.covers("src/x.rs") && !p.covers("x.rsx"));
    }
}
