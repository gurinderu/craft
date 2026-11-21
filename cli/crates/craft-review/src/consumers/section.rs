//! The report's section of the consumers list: which sources built it, why the graph was not one,
//! and what the list could not hold or place.

use super::order::FILE_MAX;
use super::{Consumers, gaps};

/// The report's section: which sources built the list, and what it could not search; empty when
/// no list was built and none was asked for.
#[must_use]
pub fn section(c: &Consumers) -> String {
    let gaps = gaps::for_report(c);
    if c.sources.is_empty() && gaps.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n## Consumers\n\n");
    if !c.sources.is_empty() {
        out.push_str(&format!(
            "Built from: {}. {} line(s) for {} changed Rust symbol(s)",
            c.sources.join(", "),
            c.lines(),
            c.symbols.len()
        ));
        if c.cut > 0 {
            out.push_str(&format!("; {} more cut by the budget", c.cut));
        }
        out.push_str(".\n");
    }
    if c.capped > 0 {
        out.push_str(&format!(
            "- {} more line(s) past the {FILE_MAX}-line cap, in no file\n",
            c.capped
        ));
    }
    out.push_str(&gaps);
    if !c.file.is_empty() {
        out.push_str(&format!("- The whole list: `{}`\n", c.file));
    }
    out
}

/// The report's line on the CONSUMERS `lines` no lens marked per line, `what` saying how; empty
/// when there are none (realm @nick/craft, node #531).
#[must_use]
pub fn gap_line(what: &str, lines: &[String]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    format!("- {} line(s) {what}: {}\n", lines.len(), gaps::shown(lines))
}
