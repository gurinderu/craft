//! One task's part of the consumers list (realm `@nick/craft`, node #625): the symbols, lines and
//! gaps of its scope, cut to its own budget, the rest left in the saved file.

use super::order::{PER_SYMBOL, budget};
use super::{Consumers, Listed, Site};

/// What a task's part keeps: the symbols, the lines of a kept symbol, and the files a gap names.
pub(super) struct Scope<'a> {
    pub symbol: &'a dyn Fn(&Listed) -> bool,
    pub site: &'a dyn Fn(&Site) -> bool,
    pub file: &'a dyn Fn(&str) -> bool,
}

/// The whole list as one scope.
pub(super) const WHOLE: Scope<'static> = Scope {
    symbol: &|_| true,
    site: &|_| true,
    file: &|_| true,
};

/// `c` narrowed to `scope` and cut to [`PER_SYMBOL`] lines a symbol and `max` in all; and how
/// many of the scope's lines the cut left out.
pub(super) fn part(c: &Consumers, scope: &Scope<'_>, max: usize) -> (Consumers, usize) {
    let mut out = c.clone();
    out.symbols = c
        .symbols
        .iter()
        .filter(|s| (scope.symbol)(s))
        .filter_map(|s| {
            let sites: Vec<Site> = s
                .sites
                .iter()
                .filter(|x| (scope.site)(x))
                .cloned()
                .collect();
            // A symbol whose every line lies outside the scope is not one no line names.
            (s.sites.is_empty() || !sites.is_empty()).then(|| Listed { sites, ..s.clone() })
        })
        .collect();
    out.unlisted.retain(|u| (scope.file)(unlisted_file(u)));
    out.unplaced
        .retain(|u| (scope.file)(u.rsplit_once(':').map_or(u.as_str(), |(f, _)| f)));
    out.unreadable.retain(|u| (scope.file)(before_why(u)));
    out.unsearched
        .retain(|u| searched_here(c, scope, before_why(u)));
    let cut = budget(&mut out.symbols, PER_SYMBOL, max);
    (out, cut)
}

/// An entry's head before its ` (why)`: a file, or a symbol's name.
fn before_why(entry: &str) -> &str {
    entry.split_once(" (").map_or(entry, |(head, _)| head)
}

/// The file of an `unlisted` entry, `name (file)`.
fn unlisted_file(entry: &str) -> &str {
    entry
        .strip_suffix(')')
        .and_then(|e| e.rsplit_once(" ("))
        .map_or(entry, |(_, file)| file)
}

/// Whether the symbol `name`, which the name search left out, is the scope's: one of that name in
/// it, or none of that name in the list at all.
fn searched_here(c: &Consumers, scope: &Scope<'_>, name: &str) -> bool {
    let mut named = c.symbols.iter().filter(|s| s.name == name).peekable();
    named.peek().is_none() || named.any(|s| (scope.symbol)(s) && (scope.file)(&s.file))
}

#[cfg(test)]
mod tests;
