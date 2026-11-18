//! The report's section of the consumers list: which sources built it, why the graph was not one,
//! and what the list could not hold or place.

use super::cbm::ROWS_PER_SYMBOL;
use super::order::FILE_MAX;
use super::text::shown;
use super::{Consumers, GRAPH};

/// The report's section: which sources built the list, and why the graph was not one; empty
/// when no list was built.
#[must_use]
pub fn section(c: &Consumers) -> String {
    if c.sources.is_empty() {
        return String::new();
    }
    let mut out = format!(
        "\n## Consumers\n\nBuilt from: {}. {} line(s) for {} changed Rust symbol(s)",
        c.sources.join(", "),
        c.lines(),
        c.symbols.len()
    );
    if c.cut > 0 {
        out.push_str(&format!("; {} more cut by the budget", c.cut));
    }
    out.push_str(".\n");
    out.push_str(&section_gaps(c));
    if !c.graph_skipped.is_empty() {
        out.push_str(&format!("- {GRAPH} not used: {}\n", c.graph_skipped));
    }
    if !c.unsearched.is_empty() {
        out.push_str(&format!(
            "- Not searched by name: {}\n",
            c.unsearched.join(", ")
        ));
    }
    if !c.file.is_empty() {
        out.push_str(&format!("- The whole list: `{}`\n", c.file));
    }
    out
}

/// The report's lines on what the list could not hold or place.
fn section_gaps(c: &Consumers) -> String {
    let mut out = String::new();
    if c.capped > 0 {
        out.push_str(&format!(
            "- {} more line(s) past the {FILE_MAX}-line cap, in no file\n",
            c.capped
        ));
    }
    if !c.unplaced.is_empty() {
        out.push_str(&format!(
            "- {} changed line(s) in no item the list could name, their uses not searched: {}\n",
            c.unplaced.len(),
            shown(&c.unplaced)
        ));
    }
    if c.graph_unlocated > 0 {
        out.push_str(&format!(
            "- {} {GRAPH} caller(s) not located in head: no line of the span names the symbol\n",
            c.graph_unlocated
        ));
    }
    if !c.graph_truncated.is_empty() {
        out.push_str(&format!(
            "- {GRAPH} callers cut at {ROWS_PER_SYMBOL} for: {}\n",
            c.graph_truncated.join(", ")
        ));
    }
    if !c.graph_unasked.is_empty() {
        out.push_str(&format!(
            "- {GRAPH} not asked for: {}\n",
            c.graph_unasked.join(", ")
        ));
    }
    out
}
