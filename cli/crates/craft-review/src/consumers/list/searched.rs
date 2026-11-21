//! A symbol's lines from the text searches: the name search, or for a name too common to search
//! by text, the structural search through its owner.

use std::path::Path;
use std::time::Instant;

use super::super::names::Unfinished;
use super::super::symbols::Symbol;
use super::super::{Consumers, NAME_SEARCH, STRUCTURAL, Site, names};
use super::{consumer, site};
use crate::cancel::Cancel;
use crate::gate::lines::Lines;

/// What the name search came to for one symbol: its lines, or a name to search by path instead
/// (too common to search, or `Some` why the search stopped at its cap).
pub(super) enum Searched {
    Sites(Vec<Site>),
    ByPath(Option<String>),
}

/// The name search's lines for `sym`, searched before `deadline` and until `cancel` is; a name too
/// common to search, or one naming more lines than the search keeps, is left for [`by_path`],
/// which runs once every symbol's name search has. A search that could not finish otherwise is
/// noted in `out`'s `unsearched`.
pub(super) fn searched(
    (top, changed): (&Path, &Lines),
    sym: &Symbol,
    (deadline, cancel): (Instant, &Cancel),
    out: &mut Consumers,
) -> Searched {
    if names::skip(&sym.name) {
        return Searched::ByPath(None);
    }
    match names::search(top, &sym.name, deadline, cancel) {
        Ok(hits) => Searched::Sites(sites_of(changed, sym, &hits, NAME_SEARCH)),
        Err(why @ Unfinished::Capped) => Searched::ByPath(Some(why.to_string())),
        Err(why) => {
            out.unsearched.push(format!("{} ({why})", sym.name));
            Searched::Sites(Vec::new())
        }
    }
}

/// The structural search's lines for `sym`, whose name is too common to search by text (`capped`,
/// why the name search stopped, when it ran); it is noted in `out`'s `unsearched` either way, with
/// what the search could not reach.
pub(super) fn by_path(
    (top, changed): (&Path, &Lines),
    sym: &Symbol,
    (deadline, cancel): (Instant, &Cancel),
    (out, capped): (&mut Consumers, Option<&str>),
) -> Vec<Site> {
    let first = capped.map_or_else(String::new, |c| format!("{c}; "));
    let found = names::by_path(top, (&sym.file, sym.line), &sym.name, deadline, cancel);
    let (note, sites) = match found {
        Ok(None) => match capped {
            Some(c) => (format!("{} ({c})", sym.name), Vec::new()),
            None => (sym.name.clone(), Vec::new()),
        },
        Ok(Some(f)) => {
            if !out.sources.iter().any(|s| s == STRUCTURAL) {
                out.sources
                    .insert(1.min(out.sources.len()), STRUCTURAL.to_owned());
            }
            let unread = if f.unread.is_empty() {
                String::new()
            } else {
                format!("; files not read: {}", f.unread.join(", "))
            };
            let note = format!(
                "{} ({first}searched by path only: a call through a value, `x.{}()`, not found{unread})",
                sym.name, sym.name
            );
            (note, sites_of(changed, sym, &f.hits, STRUCTURAL))
        }
        Err(why) => (
            format!("{} ({first}structural search: {why})", sym.name),
            Vec::new(),
        ),
    };
    out.unsearched.push(note);
    sites
}

/// The consumers among `hits` of `sym`, each found by `from`.
fn sites_of(changed: &Lines, sym: &Symbol, hits: &[names::Hit], from: &str) -> Vec<Site> {
    hits.iter()
        .filter_map(|h| {
            let kind = consumer(changed, sym, &h.file, h.line, &h.text)?;
            Some(site(&h.file, h.line, &h.text, from, kind))
        })
        .collect()
}
