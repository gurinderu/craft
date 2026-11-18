//! What the consumers list gives a run's text: the lenses' CONSUMERS block and the report's
//! section saying which sources built it.

use super::{Consumers, GRAPH};
use crate::content::{self, ContentError, vars};

/// The lenses' block; empty when the change adds or changes no symbol the list looked for.
///
/// # Errors
/// When its template is missing.
pub fn lens_block(c: &Consumers) -> Result<String, ContentError> {
    if c.symbols.is_empty() {
        return Ok(String::new());
    }
    let mut lines: Vec<String> = Vec::new();
    for s in c.symbols.iter().filter(|s| !s.sites.is_empty()) {
        lines.push(format!("`{}` ({}:{}):", s.name, s.file, s.line));
        lines.extend(
            s.sites
                .iter()
                .map(|x| format!("- {}:{}: {}", x.file, x.line, x.text)),
        );
    }
    let none: Vec<String> = c
        .symbols
        .iter()
        .filter(|s| s.sites.is_empty())
        .map(|s| format!("`{}`", s.name))
        .collect();
    if !none.is_empty() {
        lines.push(format!(
            "No line outside the change names: {}.",
            none.join(", ")
        ));
    }
    if !c.unsearched.is_empty() {
        lines.push(format!(
            "Not searched by name (find their uses yourself): {}.",
            c.unsearched.join(", ")
        ));
    }
    let cut = if c.cut == 0 {
        String::new()
    } else {
        format!(
            "; {} more cut by the budget, all in `{}`",
            c.cut,
            if c.file.is_empty() { "?" } else { &c.file }
        )
    };
    let block = content::prompt(
        "lens-consumers",
        &vars([
            ("count", c.lines().to_string()),
            ("sources", c.sources.join(" and ")),
            ("cut", cut),
            ("lines", lines.join("\n")),
        ]),
    )?;
    Ok(format!("\n{block}"))
}

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
