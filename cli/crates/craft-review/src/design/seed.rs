//! The design lens's seed and its block of the lens prompt (realm @nick/craft, node #534).

use serde::{Deserialize, Serialize};

use crate::content::{self, ContentError, vars};

/// How many lines of each part of the seed reach the prompt.
const SEED_MAX: usize = 30;

/// What the design lens is handed before it reads the diff.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seed {
    /// What the signal saw the change add, one line each.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub structure: Vec<String>,
    /// The crate graph's new edges and the cycles they close.
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

/// The seed's block of the design lens's prompt; empty when the seed is.
///
/// # Errors
/// When the template is missing or a placeholder has no value.
pub(crate) fn lens_block(seed: &Seed) -> Result<String, ContentError> {
    if seed.is_empty() {
        return Ok(String::new());
    }
    let crates = match (seed.crates.is_empty(), seed.note.is_empty()) {
        (true, true) => String::new(),
        (true, false) => crates_part(&format!("- not read: {}", seed.note))?,
        (false, _) => crates_part(&listed(&seed.crates))?,
    };
    let structure = if seed.structure.is_empty() {
        "none".to_owned()
    } else {
        listed(&seed.structure)
    };
    content::prompt(
        "lens-design-seed",
        &vars([("structure", structure), ("crates", crates)]),
    )
}
