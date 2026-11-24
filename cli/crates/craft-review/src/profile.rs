//! A language profile as data: `content/profiles/<id>.json` names its lenses (each with its brief,
//! model and flags), its scout rules and its rubric. Beside the Rust, Nix and SQL profiles (SQL:
//! realm @nick/craft, node #536) there is `general`, the retired JS adversarial-review engine's
//! lenses over every file carrying code that none of them takes (realm @nick/craft, nodes #421,
//! #445). Rust and Nix extend it, merged once at load ([`inherit`]; realm @nick/craft, node #552).

use serde::Deserialize;

use crate::agent::{AgentKind, Model};
use crate::content::{self, ContentError};

/// The profiles a run may review with, in the order a changed file is offered to them.
pub const IDS: [&str; 5] = ["rust", "nix", "sql", "runbook", "general"];

/// What files a profile reviews: a changed path ending in one of `suffixes` or named one of `names`;
/// with `rest`, every file carrying code no other profile takes, project configuration aside; with
/// `steps`, only those of its files that carry operator steps ([`crate::runbook`]), which the
/// working tree decides, not the name ([`crate::coverage::assign`]).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Detect {
    pub suffixes: Vec<String>,
    pub names: Vec<String>,
    #[serde(default)]
    pub rest: bool,
    #[serde(default)]
    pub steps: bool,
}

/// What the negative-space lens of a profile inventories as new surface, and the uses of it it
/// greps the unchanged tree for.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NegativeSpace {
    pub new_surface: String,
    pub shape_uses: String,
}

/// What a profile's units are called and what a confined lens, the contract lens and the seam pass
/// read of a unit they may not open (`RUST_UNITS` in `integrations/shared/rust-units.mjs`): another unit's
/// signatures (`<its path>` its directory), the public surface at `{{root}}`, what a public contract
/// is made of, and the public items the seam pass follows. The Rust profile's units are its Cargo
/// packages, which the binary discovers itself ([`crate::units`]).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitWords {
    pub noun: String,
    pub signatures: String,
    pub surface: String,
    pub public_items: String,
    pub changed_items: String,
}

/// Where a lens reads its catalogue, and the classes its brief carries when none is readable.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Catalogue {
    pub label: String,
    pub file: String,
    pub fallback: String,
}

/// The lens no part is withheld from: it reads a part's data files too (realm @nick/craft, node
/// #625).
pub const SECURITY: &str = "security";

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
    /// The diff signal ([`crate::lens_signal`]) that admits it: without that signal in its
    /// profile's part of the change it runs in no plan, whoever picked it, and only the
    /// completeness critic of a full review may still name it (realm @nick/craft, node #625).
    #[serde(default)]
    pub signal: Option<String>,
    /// Reviews the whole diff: a light pass skips it unless the diff calls for it.
    #[serde(default)]
    pub whole_diff: bool,
    /// Never sliced, though a light pass keeps it: the runbook lens, whose renamed files' old
    /// paths no directory slice holds (realm @nick/craft, node #620).
    #[serde(default)]
    pub unsliced: bool,
    /// The scout surface that, said absent, drops it.
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default)]
    pub catalogue: Option<Catalogue>,
    /// Metrics-or-nothing: it runs only with a code-metrics index, its brief is its whole prompt,
    /// its findings stand only on numbers over a threshold, and its verifier re-reads them
    /// ([`crate::complexity`]).
    #[serde(default)]
    pub metrics: bool,
    /// The rubric skill it is judged by when not its profile's — the embedded-SQL `sql-queries`
    /// lens of the Rust and general profiles takes `sql-review` (realm @nick/craft, node #536). Such
    /// a skill ships a `rules.md` catalog and no exclusion file of its own.
    #[serde(default)]
    pub rubric: Option<String>,
}

fn with_catalog() -> bool {
    true
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
    /// Its rubric's exclusion file; empty, or absent, when it ships none.
    #[serde(default)]
    pub fp_rules: String,
    /// Whether its rubric skill ships a `rules.md` catalog whose IDs a finding's `ruleId` cites;
    /// without one its lenses are told to leave `ruleId` empty, not to hunt for an ID.
    #[serde(default = "with_catalog")]
    pub rule_catalog: bool,
    pub nav_skill: String,
    pub security_hints: String,
    pub uses_library: bool,
    pub always_lenses: Vec<String>,
    pub safety_lens: String,
    /// What the security floor adds — on a security-sensitive or large plan, or one with no scout
    /// pick — beside the always set: the roster's security-relevant lenses, the rest left to the
    /// scout (realm @nick/craft, node #552).
    pub security_floor: Vec<String>,
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
    /// Its units for unit mode, in the words its prompts use; a profile without them finds no
    /// units (realm @nick/craft, #362).
    #[serde(default)]
    pub units: Option<UnitWords>,
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

    /// The profile `id`, `content/profiles/<id>.json`, merged with what it extends.
    ///
    /// # Errors
    /// When the profile file is missing or not of this shape, or its merge is refused
    /// ([`ContentError::BadProfile`]).
    pub fn load(id: &str) -> Result<Self, ContentError> {
        Self::load_with(id, &|id: &str| {
            content::raw(&format!("profiles/{id}.json")).map(str::to_owned)
        })
    }

    /// The profile `id`, each profile's text read by `read`, resolved through what it extends
    /// ([`inherit`]).
    ///
    /// # Errors
    /// As [`Profile::load`].
    pub(crate) fn load_with(
        id: &str,
        read: &dyn Fn(&str) -> Result<String, ContentError>,
    ) -> Result<Self, ContentError> {
        let path = format!("profiles/{id}.json");
        let profile: Self = serde_json::from_value(inherit::resolve(id, read)?)
            .map_err(|e| ContentError::NotJson(path, e.to_string()))?;
        inherit::check(&profile)?;
        Ok(profile)
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

    /// Whether `lens` is metrics-or-nothing: it judges only the graph's numbers, so one that never
    /// returned is a coverage gap that caps the verdict, not a review that could not run.
    #[must_use]
    pub fn metrics_only(&self, lens: &str) -> bool {
        self.lens(lens).is_some_and(|l| l.metrics)
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

    /// The rubric skill the lens `lens` (or a finding it raised) is judged by: its own, else the
    /// profile's.
    #[must_use]
    pub fn rubric_of(&self, lens: &str) -> &str {
        self.own_rubric(lens).unwrap_or(&self.rubric_skill)
    }

    /// The agent `lens`'s tasks run on: the profile's lens agent, except for a metrics-or-nothing
    /// lens, which judges from the numbers in its prompt alone and runs on the host's task agent.
    #[must_use]
    pub fn agent_of(&self, lens: &str) -> Option<AgentKind> {
        if self.metrics_only(lens) {
            None
        } else {
            self.lens_agent
        }
    }

    /// Whether `lens`'s rubric ships a `rules.md` catalog its findings' `ruleId` cites.
    #[must_use]
    pub fn catalog_of(&self, lens: &str) -> bool {
        self.own_rubric(lens).is_some() || self.rule_catalog
    }

    /// The exclusion file of `lens`'s rubric (`fp-rules.md`), empty when it ships none.
    #[must_use]
    pub fn fp_rules_of(&self, lens: &str) -> &str {
        if self.own_rubric(lens).is_some() {
            ""
        } else {
            &self.fp_rules
        }
    }

    fn own_rubric(&self, lens: &str) -> Option<&str> {
        self.lens(lens).and_then(|l| l.rubric.as_deref())
    }

    /// Whether the profile reviews any of `files`.
    #[must_use]
    pub fn detects(&self, files: &[String]) -> bool {
        files.iter().any(|f| self.covers(f))
    }

    /// Whether the profile may review `file` by its name: by its suffixes and names, or, a profile
    /// taking the rest, when it carries code and is no project configuration. A profile taking files
    /// by their steps matches its suffixes whatever their case (`RUNBOOK.MD`), and takes a file only
    /// when its change touches a step, which [`crate::coverage::assign`] is told; which of several
    /// profiles takes a file is its too.
    #[must_use]
    pub fn covers(&self, file: &str) -> bool {
        if self.detect.rest {
            return !crate::coverage::is_inert(file) && !crate::coverage::is_project_config(file);
        }
        let base = file.rsplit('/').next().unwrap_or(file);
        let named = if self.detect.steps {
            file.to_ascii_lowercase()
        } else {
            file.to_owned()
        };
        self.detect
            .suffixes
            .iter()
            .any(|s| named.ends_with(s.as_str()))
            || self.detect.names.iter().any(|n| n == base)
    }

    /// The files of `files` its lens `lens` reads: all of them, but for a per-file lens of a
    /// profile taking the rest, which reads no data file ([`crate::coverage::is_data`]) — its
    /// whole-diff lenses and its security lens read them (realm @nick/craft, node #625).
    #[must_use]
    pub fn reads(&self, lens: &str, files: &[String]) -> Vec<String> {
        let all = !self.detect.rest
            || lens == SECURITY
            || self
                .lens(lens)
                .is_none_or(|l| l.whole_diff || l.metrics || l.unsliced);
        files
            .iter()
            .filter(|f| all || !crate::coverage::is_data(f))
            .cloned()
            .collect()
    }

    /// Whether its lens `lens` would read nothing of the part `files` holds ([`Self::reads`]): no
    /// task of it is rendered then, whose empty pathspec would read the whole change (realm
    /// @nick/craft, node #625).
    #[must_use]
    pub fn reads_nothing(&self, lens: &str, files: &[String]) -> bool {
        !files.is_empty() && self.reads(lens, files).is_empty()
    }

    /// What a `git diff` of this profile's part of a change names: its globs, or, a profile
    /// without any, the files it took, each a literal pathspec.
    #[must_use]
    pub fn pathspec(&self, files: &[String]) -> String {
        if !self.diff_globs.is_empty() {
            return self.diff_globs.join(" ");
        }
        literal_pathspec(files)
    }
}

/// `files` as literal git pathspecs, each shell-quoted.
#[must_use]
pub fn literal_pathspec(files: &[String]) -> String {
    files
        .iter()
        .filter(|f| !f.is_empty())
        .map(|f| format!("'{}'", format!(":(literal){f}").replace('\'', r"'\''")))
        .collect::<Vec<_>>()
        .join(" ")
}

mod inherit;
#[cfg(test)]
mod tests;
