//! The design lens's seed and its block of the lens prompt (realm @nick/craft, node #534).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::content::{self, ContentError, vars};

/// How many lines of each part of the seed reach the prompt.
const SEED_MAX: usize = 30;

/// What the design lens is handed before it reads the diff.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seed {
    /// What the signal saw each profile's part of the change add, one line each, by profile.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub structure: BTreeMap<String, Vec<String>>,
    /// The crate graph's new edges and the cycles they close: the Rust profile's alone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub crates: Vec<String>,
    /// Why the crate delta is missing, when it could not be read.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub note: String,
}

impl Seed {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.structure.is_empty() && self.crates.is_empty() && self.note.is_empty()
    }
}

/// The crate delta's part of the seed block, its `lines` under their heading.
fn crates_part(lines: &str) -> Result<String, ContentError> {
    content::prompt("lens-design-crates", &vars([("lines", lines.to_owned())]))
}

fn listed(items: &[String]) -> String {
    let mut out: Vec<String> = items
        .iter()
        .take(SEED_MAX)
        .map(|l| format!("- {l}"))
        .collect();
    if items.len() > SEED_MAX {
        out.push(format!("- … and {} more", items.len() - SEED_MAX));
    }
    out.join("\n")
}

/// The seed's block of the design lens of `profile`: its own structure lines, and the crate delta
/// for the Rust profile alone; empty when it has neither.
///
/// # Errors
/// When the template is missing or a placeholder has no value.
pub(crate) fn lens_block(seed: &Seed, profile: &str) -> Result<String, ContentError> {
    let own = seed.structure.get(profile).filter(|l| !l.is_empty());
    let rust = profile == crate::consumers::PROFILE;
    let crates = match (rust, seed.crates.is_empty(), seed.note.is_empty()) {
        (false, _, _) | (true, true, true) => String::new(),
        (true, true, false) => crates_part(&format!("- not read: {}", seed.note))?,
        (true, false, _) => crates_part(&listed(&seed.crates))?,
    };
    if own.is_none() && crates.is_empty() {
        return Ok(String::new());
    }
    let structure = own.map_or_else(|| "none".to_owned(), |l| listed(l));
    content::prompt(
        "lens-design-seed",
        &vars([("structure", structure), ("crates", crates)]),
    )
}
