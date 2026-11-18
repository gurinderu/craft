//! The report's section of the consumers list: which sources built it, why the graph was not one,
//! and what the list could not hold or place.

use super::order::FILE_MAX;
use super::{Consumers, gaps};

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
    if c.capped > 0 {
        out.push_str(&format!(
            "- {} more line(s) past the {FILE_MAX}-line cap, in no file\n",
            c.capped
        ));
    }
    out.push_str(&gaps::for_report(c));
    if !c.file.is_empty() {
        out.push_str(&format!("- The whole list: `{}`\n", c.file));
    }
    out
}
