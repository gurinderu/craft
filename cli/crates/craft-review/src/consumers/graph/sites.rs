//! A graph caller's lines in head that name the symbol it calls.

use std::collections::HashMap;
use std::path::Path;

use super::super::cbm::Caller;
use super::super::list::{consumer, site};
use super::super::symbols::Symbol;
use super::super::{GRAPH, Site, source};
use super::owner::{self, Owner};
use crate::gate::lines::Lines;

/// The lines of `file` in head, read once per file as [`source::read_within`] reads it; an
/// absent file has none. Why not, `file (why)`.
fn head_lines<'a>(
    files: &'a mut HashMap<String, Result<Vec<String>, String>>,
    top: &Path,
    file: &str,
) -> Result<&'a Vec<String>, String> {
    let read = files.entry(file.to_owned()).or_insert_with(|| {
        if let Some(dir) = nested_checkout(top, file) {
            return Err(format!("{dir}/ (another checkout inside this one)"));
        }
        match source::read_within(top, file) {
            Ok(text) => Ok(text
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect()),
            Err(e) => Err(format!("{file} ({e})")),
        }
    });
    read.as_ref().map_err(Clone::clone)
}

/// The directory of `file` (relative to `top`) that is a checkout of its own — a linked worktree
/// or a clone under it, which the graph indexes with the rest and the name search leaves out.
fn nested_checkout(top: &Path, file: &str) -> Option<String> {
    let mut dir = std::path::PathBuf::new();
    let parent = Path::new(file).parent()?;
    for part in parent.components() {
        // A path outside the top, absolute or climbing, is refused when it is read.
        let std::path::Component::Normal(name) = part else {
            return None;
        };
        dir.push(name);
        if top.join(&dir).join(".git").exists() {
            return Some(dir.display().to_string());
        }
    }
    None
}

/// The lines in head that name `sym` at a caller's call line, or over its span when the edge names
/// no line inside it, in a form that can reach it ([`owner::names_as`]), and whether any line
/// there does: a line naming it nowhere, or only as another type's item, is not listed.
/// Why not, for a caller whose file is outside the repository or cannot be read.
pub(in crate::consumers) fn graph_sites(
    files: &mut HashMap<String, Result<Vec<String>, String>>,
    top: &Path,
    c: &Caller,
    sym: &Symbol,
    changed: &Lines,
) -> Result<(Vec<Site>, bool), String> {
    let owner =
        head_lines(files, top, &sym.file).map_or(Owner::Unknown, |l| owner::owner(l, sym.line));
    let lines = head_lines(files, top, &c.file)?;
    let last = u32::try_from(lines.len()).unwrap_or(u32::MAX);
    // The edge's own call line when it names one inside the span, else the whole span.
    let (from, to) = match c.line {
        Some(l) if (c.start..=c.end).contains(&l) => (l, l),
        Some(_) | None => (c.start, c.end),
    };
    let naming: Vec<(u32, &str)> = (from..=to.min(last))
        .filter_map(|n| {
            let t = lines.get(usize::try_from(n).ok()?.checked_sub(1)?)?;
            owner::names_as(t, &sym.name, &owner).then_some((n, t.as_str()))
        })
        .collect();
    let out = naming
        .iter()
        .filter_map(|&(n, t)| {
            Some(site(
                &c.file,
                n,
                t,
                GRAPH,
                consumer(changed, sym, &c.file, n, t)?,
            ))
        })
        .collect();
    Ok((out, !naming.is_empty()))
}
