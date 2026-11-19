//! The consumers list (realm @nick/craft, node #529): `craft review start` prepares, before it
//! hands out lenses, the lines of the head checkout that name each symbol the diff changes or
//! adds outside the changed lines — callers, implementors, places passing it as a value — with
//! file and line, within a per-symbol and a per-run budget, found by a name search. Each lens gets
//! the list and marks every line; the report says which sources built it. Rust symbols only.

use serde::{Deserialize, Serialize};

mod attrs;
mod braces;
mod changed;
mod gaps;
mod list;
mod make;
mod names;
mod order;
mod removed;
mod save;
mod section;
mod source;
mod symbols;
#[cfg(test)]
mod tests;
mod text;

pub use make::{build, of_checkout};
pub use save::keep;
pub use section::{gap_line, section};
pub use text::{confined_block, lens_block, seam_block};

/// The name search's name in the report and on a site.
pub const NAME_SEARCH: &str = "name search";
/// The one profile whose lenses and seam pass are handed the list: its lines are that track's.
pub const PROFILE: &str = "rust";
/// The run directory's file holding the whole list.
pub const FILE: &str = "consumers.json";
/// A site's kind when its line declares another item of the symbol's name: a trait method's
/// implementation or a same-named method of a sibling.
pub const SAME_NAME: &str = "declares the same name";

/// One line that names a changed symbol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Site {
    pub file: String,
    pub line: u32,
    pub text: String,
    /// The sources that found it.
    pub from: Vec<String>,
    /// What the line is, when not a plain use: [`SAME_NAME`].
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
}

/// A changed symbol and the lines that name it, as many as the budgets keep.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Listed {
    pub name: String,
    pub file: String,
    pub line: u32,
    pub sites: Vec<Site>,
}

/// What a run's list came to. Every field optional, so a state written before it reads as a run
/// that built none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Consumers {
    /// Why no list could be built at all: the change's diff or its checkout could not be read, or
    /// the build stopped.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub failed: String,
    /// The sources that built the list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub symbols: Vec<Listed>,
    /// The changed symbols not searched by name: too common a name, or the search failed, each with
    /// why when it is not the name alone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unsearched: Vec<String>,
    /// The changed lines (`file:line`) in no item the list could name, so no symbol of theirs
    /// was searched.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unplaced: Vec<String>,
    /// The changed symbols past the per-run limit, not searched by name: `name (file)`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unlisted: Vec<String>,
    /// The changed Rust files whose symbols were not read, each with why: `file (why)`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unreadable: Vec<String>,
    /// How many lines past the whole list's hard cap no file holds.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub capped: usize,
    /// How many lines the lenses' budget left out of their part.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cut: usize,
    /// Where the whole list is written.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub file: String,
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde passes a reference"
)]
fn is_zero(n: &usize) -> bool {
    *n == 0
}

impl Consumers {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// How many lines the list holds.
    #[must_use]
    pub fn lines(&self) -> usize {
        self.symbols.iter().map(|s| s.sites.len()).sum()
    }

    /// Each line the list holds as `file:line`, once, in the list's order.
    #[must_use]
    pub fn sites(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for s in self.symbols.iter().flat_map(|s| &s.sites) {
            let site = format!("{}:{}", s.file, s.line);
            if !out.contains(&site) {
                out.push(site);
            }
        }
        out
    }
}
