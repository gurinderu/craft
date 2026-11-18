//! The consumers list (realm @nick/craft, node #529): `craft review start` prepares, before it
//! hands out lenses, the lines of the head checkout that name each symbol the diff changes or
//! adds outside the changed lines — callers, implementors, places passing it as a value — with
//! file and line, within a per-symbol and a per-run budget. It unions the code graph's callers,
//! when the reviewer's profile says the graph answers and its index is not older than the base,
//! with a name search, always run, because the graph loses edges. Each lens gets the list and
//! marks every line; the report says which sources built it. Rust symbols only.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::project::CodeGraph;

mod attrs;
mod braces;
pub mod cbm;
mod fresh;
mod graph;
mod list;
mod names;
mod order;
mod save;
mod section;
mod source;
mod symbols;
#[cfg(test)]
mod tests;
mod text;

pub use graph::graph_of;
pub use save::keep;
pub use section::section;
pub use text::lens_block;

/// The name search's name in the report and on a site.
pub const NAME_SEARCH: &str = "name search";
/// The code graph's.
pub const GRAPH: &str = "codebase-memory";
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
    /// The sources that built the list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
    /// Why the code graph was not one of them.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub graph_skipped: String,
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
    /// The changed symbols past the per-run limit, neither searched by name nor asked of the graph:
    /// `name (file)`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unlisted: Vec<String>,
    /// The changed Rust files whose symbols were not read, each with why: `file (why)`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unreadable: Vec<String>,
    /// How many of the graph's callers no line of head's span names the symbol in.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub graph_unlocated: usize,
    /// The symbols whose graph callers were not asked, each with why (the time bound, a failed
    /// question): `name (why)`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub graph_unasked: Vec<String>,
    /// The symbols whose graph callers were cut at the per-symbol limit.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub graph_truncated: Vec<String>,
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
}

/// The list for the change of the working tree at `top` against `diff`'s base (read from its
/// merge-base, as the lenses' diff), over its changed files, the graph asked when `graph` names
/// one.
#[must_use]
pub fn build(top: &Path, diff: &crate::git::Diff, graph: Result<CodeGraph, String>) -> Consumers {
    let text = crate::git::zero_context_diff(top, &diff.base).unwrap_or_default();
    let changed = crate::gate::lines::Lines::parse(&text);
    let found = symbols::changed(top, &diff.files, &changed, list::SYMBOLS_MAX);
    let (asked, graph_skipped) = match graph {
        Ok(g) => graph::graph_callers(top, &diff.merge_base, &g, &found.symbols),
        Err(why) => (None, why),
    };
    let callers = asked.as_ref().map(|a| a.callers.as_slice());
    let mut out = list::assemble(top, &changed, &found.symbols, callers);
    if let Some(a) = asked {
        out.graph_truncated = a.truncated;
        out.graph_unasked = a.unasked;
    }
    out.graph_skipped = graph_skipped;
    out.unplaced = found.unplaced;
    out.unlisted = found.unlisted;
    out.unreadable = found.unreadable;
    out
}
