//! The lenses' CONSUMERS block of the consumers list: each task's part of it ([`super::scope`]).

use super::order::{FILE_MAX, LENS_MAX, SEAM_MAX};
use super::scope::{Scope, WHOLE, part};
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
        format!("{elsewhere} more line(s) name these symbols in other {noun}s: the seam pass checks them, not you.")
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
    let (seam, cut) = part(c, &WHOLE, SEAM_MAX);
    let gaps = gaps::for_lens(&seam);
    if seam.symbols.is_empty() && gaps.is_empty() {
        return String::new();
    }
    let (mut lines, _) = site_lines(&seam);
    lines.extend(gaps);
    format!(
        "\n   The consumers list ({}{}) names these lines outside the change; start from them:\n{}",
        c.sources.join(" and "),
        cut_text(c, cut),
        lines.join("\n")
    )
}

/// The lines the seam pass's part shows, as `file:line`.
#[must_use]
pub fn seam_sites(c: &Consumers) -> Vec<String> {
    part(c, &WHOLE, SEAM_MAX).0.sites()
}

/// The block over `scope`'s part of `c`, `tail` said after the gaps.
fn render(c: &Consumers, scope: &Scope<'_>, tail: Option<String>) -> Result<String, ContentError> {
    let (mine, cut) = part(c, scope, LENS_MAX);
    let gaps = gaps::for_lens(&mine);
    if mine.symbols.is_empty() && gaps.is_empty() {
        return Ok(String::new());
    }
    let (mut lines, count) = site_lines(&mine);
    lines.extend(gaps);
    lines.extend(tail);
    let block = content::prompt(
        "lens-consumers",
        &vars([
            ("count", count.to_string()),
            ("sources", c.sources.join(" and ")),
            ("cut", cut_text(c, cut)),
            ("lines", lines.join("\n")),
        ]),
    )?;
    Ok(format!("\n{block}"))
}

/// Each symbol's sites under its name, then the symbols no line names; and how many sites there
/// are.
fn site_lines(c: &Consumers) -> (Vec<String>, usize) {
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
    (lines, c.lines())
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
