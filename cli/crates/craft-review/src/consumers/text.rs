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
    render(c, &|_| true, None)
}

/// The block of a lens confined to the units rooted at `roots` (`.` the whole repository): only
/// the lines under them, the rest counted as the seam pass's, which checks the other `noun`s.
///
/// # Errors
/// When its template is missing.
pub fn confined_block(c: &Consumers, roots: &[String], noun: &str) -> Result<String, ContentError> {
    let under = |x: &Site| {
        roots
            .iter()
            .any(|r| r == "." || x.file.starts_with(&format!("{r}/")))
    };
    let elsewhere = c
        .symbols
        .iter()
        .flat_map(|s| &s.sites)
        .filter(|x| !under(x))
        .count();
    let tail = (elsewhere > 0).then(|| {
        format!("{elsewhere} more line(s) name these symbols in other {noun}s: the seam pass checks them, not you.")
    });
    render(c, &under, tail)
}

/// The seam pass's part: every listed line and every gap, with no answer to give per line.
#[must_use]
pub fn seam_block(c: &Consumers) -> String {
    let gaps = gaps::for_lens(c);
    if c.symbols.is_empty() && gaps.is_empty() {
        return String::new();
    }
    let (mut lines, _) = site_lines(c, &|_| true);
    lines.extend(gaps);
    format!(
        "\n   The consumers list ({}) names these lines outside the change; start from them:\n{}",
        c.sources.join(" and "),
        lines.join("\n")
    )
}

/// The block over the sites `keep` takes, `tail` said after the gaps.
fn render(
    c: &Consumers,
    keep: &dyn Fn(&Site) -> bool,
    tail: Option<String>,
) -> Result<String, ContentError> {
    let gaps = gaps::for_lens(c);
    if c.symbols.is_empty() && gaps.is_empty() {
        return Ok(String::new());
    }
    let (mut lines, count) = site_lines(c, keep);
    lines.extend(gaps);
    lines.extend(tail);
    let block = content::prompt(
        "lens-consumers",
        &vars([
            ("count", count.to_string()),
            ("sources", c.sources.join(" and ")),
            ("cut", cut_text(c)),
            ("lines", lines.join("\n")),
        ]),
    )?;
    Ok(format!("\n{block}"))
}

/// Each symbol's sites `keep` takes, under its name, then the symbols no line names; and how many
/// sites were taken.
fn site_lines(c: &Consumers, keep: &dyn Fn(&Site) -> bool) -> (Vec<String>, usize) {
    let mut lines: Vec<String> = Vec::new();
    let mut count = 0;
    for s in &c.symbols {
        let kept: Vec<&Site> = s.sites.iter().filter(|x| keep(x)).collect();
        if kept.is_empty() {
            continue;
        }
        count += kept.len();
        lines.push(format!("`{}` ({}:{}):", s.name, s.file, s.line));
        lines.extend(kept.into_iter().map(site_line));
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
    (lines, count)
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
