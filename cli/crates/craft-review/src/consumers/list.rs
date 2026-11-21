//! The list assembled: each symbol's lines from the name search and the graph's callers, a line
//! found by both kept once with both sources, ranked and held to a hard cap
//! ([`super::order`]).

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use super::cbm::Caller;
use super::graph::graph_sites;
use super::order::{FILE_MAX, budget, rank};
use super::symbols::{Symbol, declared};
use super::{Consumers, GRAPH, Listed, NAME_SEARCH, SAME_NAME, Site, names};
use crate::cancel::Cancel;
use crate::gate::lines::Lines;

mod searched;

use searched::{Searched, by_path, searched};

/// How many changed symbols are searched.
pub(super) const SYMBOLS_MAX: usize = 40;
/// How much of a line's text is kept.
const TEXT_MAX: usize = 160;

/// What the line `file:line` reading `text` is to `sym`: `None` when it is no consumer — a
/// changed line, the symbol's own declaration, a comment; [`SAME_NAME`] when it declares another
/// item of that name (an implementor or a sibling); an empty kind for a plain use.
pub(super) fn consumer(
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

pub(super) fn site(file: &str, line: u32, text: &str, from: &str, kind: &str) -> Site {
    Site {
        file: file.to_owned(),
        line,
        text: text.trim().chars().take(TEXT_MAX).collect(),
        from: vec![from.to_owned()],
        kind: kind.to_owned(),
    }
}

/// Adds `s`, or its source to the same line already held.
fn merge(sites: &mut Vec<Site>, s: Site) {
    match sites
        .iter_mut()
        .find(|o| o.file == s.file && o.line == s.line)
    {
        Some(o) => {
            for f in s.from {
                if !o.from.contains(&f) {
                    o.from.push(f);
                }
            }
        }
        None => sites.push(s),
    }
}

/// The list of `found`, its name search run until `cancel` is, `callers` (the graph's, when
/// asked) merged in.
pub(super) fn assemble(
    top: &Path,
    changed: &Lines,
    found: &[Symbol],
    cancel: &Cancel,
    callers: Option<&[Caller]>,
) -> Consumers {
    let mut out = Consumers {
        sources: std::iter::once(NAME_SEARCH)
            .chain(callers.map(|_| GRAPH))
            .map(str::to_owned)
            .collect(),
        ..Consumers::default()
    };
    let mut files = HashMap::new();
    let deadline = Instant::now() + names::BUDGET;
    // Every name search first, so a distinctive name never waits on a common one's structural one.
    let named: Vec<Searched> = found
        .iter()
        .map(|sym| searched((top, changed), sym, (deadline, cancel), &mut out))
        .collect();
    // The workspace's packages and their dependencies, read once for every structural search.
    let ws = std::cell::OnceCell::new();
    for (sym, named) in found.iter().zip(named) {
        let mut sites = match named {
            Searched::Sites(sites) => sites,
            Searched::ByPath(capped) => by_path(
                (
                    top,
                    changed,
                    ws.get_or_init(|| names::workspace(top, (deadline, cancel))),
                ),
                sym,
                (deadline, cancel),
                (&mut out, capped.as_deref()),
            ),
        };
        let theirs = callers.unwrap_or_default().iter();
        let of_sym = theirs.filter(|c| c.symbol == sym.name && c.defined_in == sym.file);
        for c in of_sym {
            graph_into(&mut out, &mut sites, &mut files, (top, changed), (c, sym));
        }
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

/// Adds the head lines of the graph's caller `c` of `sym` to `sites`, or notes in `out` why it
/// has none: no line of its span names the symbol, or its file could not be read.
fn graph_into(
    out: &mut Consumers,
    sites: &mut Vec<Site>,
    files: &mut HashMap<String, Result<Vec<String>, String>>,
    (top, changed): (&Path, &Lines),
    (c, sym): (&Caller, &Symbol),
) {
    match graph_sites(files, top, c, sym, changed) {
        Ok((found, located)) => {
            out.graph_unlocated += usize::from(!located);
            for s in found {
                merge(sites, s);
            }
        }
        Err(why) if !out.graph_unreadable.contains(&why) => out.graph_unreadable.push(why),
        Err(_) => {}
    }
}
