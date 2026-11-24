//! The lenses' CONSUMERS block of the consumers list: each task's part of it ([`super::scope`]).

use super::order::{FILE_MAX, LENS_MAX, SEAM_MAX};
use super::scope::{Part, Scope, WHOLE, part};
use super::{Consumers, Site, gaps};
use crate::content::{self, ContentError, vars};

/// The block of a lens over the whole list; empty when the change adds or changes no symbol the
/// list looked for and left nothing unsearched.
///
/// # Errors
/// When its template is missing.
pub fn lens_block(c: &Consumers) -> Result<String, ContentError> {
    render(c, &WHOLE, None)
}

/// The block of a lens over a directory slice of `files`: the symbols declared in them, their
/// lines and the gaps in those files (realm `@nick/craft`, node #625).
///
/// # Errors
/// When its template is missing.
pub fn slice_block(c: &Consumers, files: &[String]) -> Result<String, ContentError> {
    let mine = |f: &str| files.iter().any(|x| x == f);
    let scope = Scope {
        symbol: &|s| mine(&s.file),
        site: &|_| true,
        file: &mine,
    };
    render(c, &scope, None)
}

/// The block of a lens confined to the units rooted at `roots` (`.` the whole repository): only
/// the lines under them, the rest counted as the seam pass's, which checks the other `noun`s.
///
/// # Errors
/// When its template is missing.
pub fn confined_block(c: &Consumers, roots: &[String], noun: &str) -> Result<String, ContentError> {
    let under_file = |f: &str| {
        roots
            .iter()
            .any(|r| r == "." || f.starts_with(&format!("{r}/")))
    };
    let under = |x: &Site| under_file(&x.file);
    let elsewhere = c
        .symbols
        .iter()
        .flat_map(|s| &s.sites)
        .filter(|x| !under(x))
        .count();
    let tail = (elsewhere > 0).then(|| {
        format!("{elsewhere} more line(s) name these symbols in other {noun}s: not yours — the seam pass starts from them, to its own budget.")
    });
    let scope = Scope {
        symbol: &|_| true,
        site: &under,
        file: &under_file,
    };
    render(c, &scope, tail)
}

/// The seam pass's part: every listed line to its budget and every gap, with no answer to give
/// per line.
#[must_use]
pub fn seam_block(c: &Consumers) -> String {
    let seam = part(c, &WHOLE, SEAM_MAX);
    let gaps = gaps::for_lens(&seam.list);
    if seam.list.symbols.is_empty() && gaps.is_empty() {
        return String::new();
    }
    let mut lines = site_lines(&seam, c);
    lines.extend(gaps);
    format!(
        "\n   The consumers list ({}{}) names these lines outside the change; start from them:\n{}",
        c.sources.join(" and "),
        cut_text(c, seam.cut),
        lines.join("\n")
    )
}

/// The lines the seam pass's part shows, as `file:line`.
#[must_use]
pub fn seam_sites(c: &Consumers) -> Vec<String> {
    part(c, &WHOLE, SEAM_MAX).list.sites()
}

/// The block over `scope`'s part of `c`, `tail` said after the gaps.
fn render(c: &Consumers, scope: &Scope<'_>, tail: Option<String>) -> Result<String, ContentError> {
    let mine = part(c, scope, LENS_MAX);
    let gaps = gaps::for_lens(&mine.list);
    if mine.list.symbols.is_empty() && gaps.is_empty() {
        return Ok(String::new());
    }
    let mut lines = site_lines(&mine, c);
    lines.extend(gaps);
    lines.extend(tail);
    let block = content::prompt(
        "lens-consumers",
        &vars([
            ("count", mine.list.lines().to_string()),
            ("sources", c.sources.join(" and ")),
            ("cut", cut_text(c, mine.cut)),
            ("lines", lines.join("\n")),
        ]),
    )?;
    Ok(format!("\n{block}"))
}

/// Each symbol's sites in `part` under its name, then the symbols the budget left no line of, then
/// those no line names: searched by name in `full`, the whole list, and nothing found.
fn site_lines(part: &Part, full: &Consumers) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for s in part.list.symbols.iter().filter(|s| !s.sites.is_empty()) {
        lines.push(format!("`{}` ({}:{}):", s.name, s.file, s.line));
        lines.extend(s.sites.iter().map(site_line));
    }
    let named = |v: &[&str]| {
        v.iter()
            .map(|n| format!("`{n}`"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let emptied: Vec<&str> = part.emptied.iter().map(String::as_str).collect();
    if !emptied.is_empty() {
        lines.push(format!(
            "Every line of these was cut by the budget, kept in the whole list: {}.",
            named(&emptied)
        ));
    }
    let none: Vec<&str> = part
        .list
        .symbols
        .iter()
        .filter(|s| s.sites.is_empty() && !emptied.contains(&s.name.as_str()))
        .filter(|s| !unsearched(full, &s.name))
        .map(|s| s.name.as_str())
        .collect();
    if !none.is_empty() {
        lines.push(format!(
            "No line outside the change names: {}.",
            named(&none)
        ));
    }
    lines
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

/// The word on the `cut` lines of a part its budget left out: where the whole list keeps them, and
/// any past the saved list's cap.
fn cut_text(c: &Consumers, cut: usize) -> String {
    if cut == 0 {
        return String::new();
    }
    if c.file.is_empty() {
        return format!("; {cut} more cut by the budget (the whole list could not be saved)");
    }
    let whole = format!(
        "; {cut} more cut by the budget to keep this prompt small, not yours to mark: the whole list is `{}` (JSON, each symbol's `sites`), read it when a judgment needs them",
        c.file
    );
    if c.capped == 0 {
        return whole;
    }
    format!(
        "{whole}; it stops at {FILE_MAX} lines ({} more listed nowhere)",
        c.capped
    )
}
