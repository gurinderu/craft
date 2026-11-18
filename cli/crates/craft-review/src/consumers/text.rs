//! The lenses' CONSUMERS block of the consumers list.

use super::order::FILE_MAX;
use super::{Consumers, Site};
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
        lines.extend(s.sites.iter().map(site_line));
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
    lines.extend(gaps(c));
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

/// One listed line, its kind after it when it is not a plain use.
fn site_line(x: &Site) -> String {
    let kind = if x.kind.is_empty() {
        String::new()
    } else {
        format!(" ({}: an implementor or a sibling)", x.kind)
    };
    format!("- {}:{}: {}{kind}", x.file, x.line, x.text)
}

/// What the lenses must look for themselves: names not searched, changed lines in no item, and
/// symbols whose graph callers were cut or not asked.
fn gaps(c: &Consumers) -> Vec<String> {
    let said = [
        (
            &c.unsearched,
            "Not searched by name (find their uses yourself)",
        ),
        (
            &c.unplaced,
            "Changed lines in no item this list could name (find what they change and its uses yourself)",
        ),
        (
            &c.graph_truncated,
            "The code graph's callers were cut for (find the rest yourself)",
        ),
        (
            &c.graph_unreadable,
            "The code graph's callers in files not read here (read them yourself)",
        ),
        (
            &c.graph_unasked,
            "The code graph was not asked for the callers of (find them yourself)",
        ),
    ];
    said.iter()
        .filter(|(v, _)| !v.is_empty())
        .map(|(v, what)| format!("{what}: {}.", shown(v)))
        .collect()
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
