//! The list assembled: each symbol's lines from the name search and the graph's callers, a line
//! found by both kept once with both sources, ranked same crate first and tests last, cut to the
//! budgets.

use std::collections::HashMap;
use std::path::Path;

use super::cbm::{Caller, Cbm};
use super::symbols::{Symbol, declared, is_test_path};
use super::{Consumers, GRAPH, Listed, NAME_SEARCH, Site, fresh, names};
use crate::gate::lines::Lines;
use crate::project::CodeGraph;

/// How many changed symbols are searched.
pub(super) const SYMBOLS_MAX: usize = 40;
/// How many lines one symbol keeps.
pub(super) const PER_SYMBOL: usize = 10;
/// How many lines the whole list keeps.
pub(super) const RUN_MAX: usize = 80;
/// How much of a line's text is kept.
const TEXT_MAX: usize = 160;

/// The graph's callers of `found`, or why the graph was not asked: its index not ready or older
/// than `merge_base`, or no answer.
pub(super) fn graph_callers(
    top: &Path,
    merge_base: &str,
    g: &CodeGraph,
    found: &[Symbol],
) -> (Option<Vec<Caller>>, String) {
    let cbm = Cbm::new(&g.tool);
    let asked = cbm.indexed_at(&g.project).and_then(|at| {
        if let Some(why) = fresh::stale(top, merge_base, &g.project, &at) {
            return Err(why);
        }
        let names: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
        cbm.callers(&g.project, &names)
    });
    match asked {
        Ok(c) => (Some(c), String::new()),
        Err(why) => (None, why),
    }
}

/// Whether the line `file:line` reading `text` is a consumer of `sym`: not a changed line, not a
/// declaration of that name, not a comment.
fn consumer(changed: &Lines, sym: &Symbol, file: &str, line: u32, text: &str) -> bool {
    let t = text.trim_start();
    let at_declaration = file == sym.file && line == sym.line;
    !(changed.touches(file, line)
        || declared(text) == Some(sym.name.as_str())
        || t.starts_with("//")
        || at_declaration)
}

fn site(file: &str, line: u32, text: &str, from: &str) -> Site {
    Site {
        file: file.to_owned(),
        line,
        text: text.trim().chars().take(TEXT_MAX).collect(),
        from: vec![from.to_owned()],
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

/// The lines of a caller's span that name `sym`; its first line when none does, so the caller is
/// listed still.
fn graph_sites(
    files: &mut HashMap<String, Vec<String>>,
    top: &Path,
    c: &Caller,
    sym: &Symbol,
    changed: &Lines,
) -> Vec<Site> {
    let lines = files.entry(c.file.clone()).or_insert_with(|| {
        let text = std::fs::read_to_string(top.join(&c.file)).unwrap_or_default();
        text.lines().map(str::to_owned).collect()
    });
    let at = |n: u32| {
        lines
            .get(usize::try_from(n).ok()?.checked_sub(1)?)
            .map(String::as_str)
    };
    let mut out: Vec<Site> = (c.start..=c.end)
        .filter_map(|n| Some((n, at(n)?)))
        .filter(|(n, t)| names::names(t, &sym.name) && consumer(changed, sym, &c.file, *n, t))
        .map(|(n, t)| site(&c.file, n, t, GRAPH))
        .collect();
    if out.is_empty() && !changed.touches(&c.file, c.start) {
        out.push(site(
            &c.file,
            c.start,
            at(c.start).unwrap_or_default(),
            GRAPH,
        ));
    }
    out
}

/// The repository-relative directory of the crate holding `file`: the nearest one above it with
/// a `Cargo.toml`; empty at the top.
fn crate_dir(top: &Path, file: &str) -> String {
    let mut dir = Path::new(file).parent();
    while let Some(d) = dir.filter(|d| !d.as_os_str().is_empty()) {
        if top.join(d).join("Cargo.toml").is_file() {
            return d.display().to_string();
        }
        dir = d.parent();
    }
    String::new()
}

/// Same crate first, tests last, then by place.
fn rank(top: &Path, sym: &Symbol, sites: &mut [Site]) {
    let home = crate_dir(top, &sym.file);
    let away = |f: &str| !home.is_empty() && !f.starts_with(&format!("{home}/"));
    sites.sort_by(|a, b| {
        let key = |s: &Site| (is_test_path(&s.file), away(&s.file));
        key(a)
            .cmp(&key(b))
            .then_with(|| (&a.file, a.line).cmp(&(&b.file, b.line)))
    });
}

/// The list of `found`, its name search run, `callers` (the graph's, when asked) merged in.
pub(super) fn assemble(
    top: &Path,
    changed: &Lines,
    found: &[Symbol],
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
    for sym in found {
        let mut sites = searched(top, changed, sym, &mut out.unsearched);
        let theirs = callers.unwrap_or_default().iter();
        for c in theirs.filter(|c| c.symbol == sym.name && c.defined_in == sym.file) {
            for s in graph_sites(&mut files, top, c, sym, changed) {
                merge(&mut sites, s);
            }
        }
        rank(top, sym, &mut sites);
        out.symbols.push(Listed {
            name: sym.name.clone(),
            file: sym.file.clone(),
            line: sym.line,
            sites,
        });
    }
    out.cut = budget(&mut out.symbols);
    out
}

/// The name search's lines for `sym`; a name too common to search is noted in `unsearched`.
fn searched(top: &Path, changed: &Lines, sym: &Symbol, unsearched: &mut Vec<String>) -> Vec<Site> {
    if names::skip(&sym.name) {
        unsearched.push(sym.name.clone());
        return Vec::new();
    }
    match names::search(top, &sym.name) {
        Ok(hits) => hits
            .iter()
            .filter(|h| consumer(changed, sym, &h.file, h.line, &h.text))
            .map(|h| site(&h.file, h.line, &h.text, NAME_SEARCH))
            .collect(),
        Err(why) => {
            unsearched.push(format!("{} ({why})", sym.name));
            Vec::new()
        }
    }
}

/// Cuts each symbol to [`PER_SYMBOL`] lines and all of them to [`RUN_MAX`], taking one line of
/// each symbol in turn so a late symbol is not starved; how many lines were cut.
pub(super) fn budget(symbols: &mut [Listed]) -> usize {
    let total: usize = symbols.iter().map(|s| s.sites.len()).sum();
    let mut keep = vec![0usize; symbols.len()];
    let mut kept = 0;
    for round in 0..PER_SYMBOL {
        for (k, s) in keep.iter_mut().zip(symbols.iter()) {
            if kept < RUN_MAX && s.sites.len() > round {
                *k += 1;
                kept += 1;
            }
        }
    }
    for (s, k) in symbols.iter_mut().zip(keep) {
        s.sites.truncate(k);
    }
    total - kept
}
