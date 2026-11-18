//! The list assembled: each symbol's lines from the name search, ranked and held to a hard cap
//! ([`super::order`]).

use std::path::Path;
use std::time::Instant;

use super::order::{FILE_MAX, budget, rank};
use super::symbols::{Symbol, declared};
use super::{Consumers, Listed, NAME_SEARCH, SAME_NAME, Site, names};
use crate::gate::lines::Lines;

/// How many changed symbols are searched.
pub(super) const SYMBOLS_MAX: usize = 40;
/// How much of a line's text is kept.
const TEXT_MAX: usize = 160;

/// What the line `file:line` reading `text` is to `sym`: `None` when it is no consumer — a
/// changed line, the symbol's own declaration, a comment; [`SAME_NAME`] when it declares another
/// item of that name (an implementor or a sibling); an empty kind for a plain use.
fn consumer(
    changed: &Lines,
    sym: &Symbol,
    file: &str,
    line: u32,
    text: &str,
) -> Option<&'static str> {
    let own = file == sym.file && line == sym.line;
    if own || changed.touches(file, line) || text.trim_start().starts_with("//") {
        return None;
    }
    Some(if declared(text) == Some(sym.name.as_str()) {
        SAME_NAME
    } else {
        ""
    })
}

fn site(file: &str, line: u32, text: &str, from: &str, kind: &str) -> Site {
    Site {
        file: file.to_owned(),
        line,
        text: text.trim().chars().take(TEXT_MAX).collect(),
        from: vec![from.to_owned()],
        kind: kind.to_owned(),
    }
}

/// The list of `found`, its name search run.
pub(super) fn assemble(top: &Path, changed: &Lines, found: &[Symbol]) -> Consumers {
    let mut out = Consumers {
        sources: vec![NAME_SEARCH.to_owned()],
        ..Consumers::default()
    };
    let deadline = Instant::now() + names::BUDGET;
    for sym in found {
        let mut sites = searched(top, changed, sym, deadline, &mut out.unsearched);
        rank(top, sym, &mut sites);
        out.symbols.push(Listed {
            name: sym.name.clone(),
            file: sym.file.clone(),
            line: sym.line,
            sites,
        });
    }
    out.capped = budget(&mut out.symbols, usize::MAX, FILE_MAX);
    out
}

/// The name search's lines for `sym`, searched before `deadline`; a name too common to search, or
/// one the search could not finish, is noted in `unsearched`.
fn searched(
    top: &Path,
    changed: &Lines,
    sym: &Symbol,
    deadline: Instant,
    unsearched: &mut Vec<String>,
) -> Vec<Site> {
    if names::skip(&sym.name) {
        unsearched.push(sym.name.clone());
        return Vec::new();
    }
    match names::search(top, &sym.name, deadline) {
        Ok(hits) => hits
            .iter()
            .filter_map(|h| {
                let kind = consumer(changed, sym, &h.file, h.line, &h.text)?;
                Some(site(&h.file, h.line, &h.text, NAME_SEARCH, kind))
            })
            .collect(),
        Err(why) => {
            unsearched.push(format!("{} ({why})", sym.name));
            Vec::new()
        }
    }
}
