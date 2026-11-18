//! The lenses' CONSUMERS block of the consumers list.

use super::order::FILE_MAX;
use super::{Consumers, Site, gaps};
use crate::content::{self, ContentError, vars};

/// The lenses' block; empty when the change adds or changes no symbol the list looked for and
/// left nothing unsearched.
///
/// # Errors
/// When its template is missing.
pub fn lens_block(c: &Consumers) -> Result<String, ContentError> {
    let gaps = gaps::for_lens(c);
    if c.symbols.is_empty() && gaps.is_empty() {
        return Ok(String::new());
    }
    let mut lines: Vec<String> = Vec::new();
    for s in c.symbols.iter().filter(|s| !s.sites.is_empty()) {
        lines.push(format!("`{}` ({}:{}):", s.name, s.file, s.line));
        lines.extend(s.sites.iter().map(site_line));
    }
    let none: Vec<String> = c
        .symbols
        .iter()
        .filter(|s| s.sites.is_empty() && !unsearched(c, &s.name))
        .map(|s| format!("`{}`", s.name))
        .collect();
    if !none.is_empty() {
        lines.push(format!(
            "No line outside the change names: {}.",
            none.join(", ")
        ));
    }
    lines.extend(gaps);
    let cut = cut_text(c);
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

/// Whether the name search left `name` out: an `unsearched` entry is the name, or the name and
/// why in brackets.
fn unsearched(c: &Consumers, name: &str) -> bool {
    c.unsearched
        .iter()
        .any(|u| u == name || u.strip_prefix(name).is_some_and(|r| r.starts_with(" (")))
}

/// One listed line, its kind after it when it is not a plain use.
fn site_line(x: &Site) -> String {
    let kind = if x.kind.is_empty() {
        String::new()
    } else {
        format!(" ({}: an implementor or a sibling)", x.kind)
    };
    format!("- {}:{}: {}{kind}", x.file, x.line, x.text)
}

/// The lens text's word on the lines its budget cut, and on any past the saved list's cap.
fn cut_text(c: &Consumers) -> String {
    if c.cut == 0 {
        return String::new();
    }
    if c.file.is_empty() {
        return format!(
            "; {} more cut by the budget (the whole list could not be saved)",
            c.cut
        );
    }
    if c.capped == 0 {
        return format!("; {} more cut by the budget, all in `{}`", c.cut, c.file);
    }
    format!(
        "; {} more cut by the budget, in `{}`, which stops at {FILE_MAX} lines ({} more listed nowhere)",
        c.cut, c.file, c.capped
    )
}

/// How many entries of a list a text names before it counts the rest.
const SHOWN_MAX: usize = 20;

/// `v` joined, past [`SHOWN_MAX`] entries counted instead of named.
pub(super) fn shown(v: &[String]) -> String {
    let head = v
        .iter()
        .take(SHOWN_MAX)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    match v.len().saturating_sub(SHOWN_MAX) {
        0 => head,
        more => format!("{head} and {more} more"),
    }
}
