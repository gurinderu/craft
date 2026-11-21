//! The structural search (realm @nick/craft, nodes #529, #564): a too-common name's lines whose
//! paths reach it through its owner ([`paths`]), over the files `git grep` finds naming the name
//! (and the owner, for a type's or a trait's item), each read as the list reads a file
//! ([`source::read_within`]) and parsed within the search's deadline.

use std::path::Path;
use std::time::Instant;

use tree_sitter::Tree;

use super::super::source;
use super::paths::{self, Kind, Resolver};
use super::stream::out_of_time;
use super::unit::Workspace;
use super::{HITS_MAX, Hit};
use crate::cancel::{Cancel, STOPPED};

mod around;
mod files;
mod reading;

use around::{Reexported, implemented};
use files::candidates;
use reading::{Reading, shared};

/// How many files a free function's search reads, those nearest its own file first.
pub(in crate::consumers) const FREE_FILES_MAX: usize = 300;

/// What the structural search found: the lines, the files it could not read, `file (why)`, and
/// how many of the files naming the item were read, when not all.
#[derive(Debug, Default)]
pub(in crate::consumers) struct Found {
    pub hits: Vec<Hit>,
    pub unread: Vec<String>,
    pub partial: Option<String>,
}

/// The deadline and the stop a search runs under.
type Until<'a> = (Instant, &'a Cancel);

/// The lines of the working tree's Rust sources at `top` whose paths reach `name`, declared at
/// `declared` (`file`, 1-based line), each read in its place in `ws`; `None` when no function of
/// that name starts there, it is a blanket `impl`'s or inside another's body, it is a free one
/// and `ws` is unread, or its file is absent; `Err` once more than [`HITS_MAX`] lines do, when its own file cannot be read, when
/// `deadline` passes or `cancel` is first, or with git's reason.
pub(in crate::consumers) fn by_path(
    top: &Path,
    (file, line): (&str, u32),
    (name, ws): (&str, &Workspace),
    deadline: Instant,
    cancel: &Cancel,
) -> Result<Option<Found>, String> {
    let until = (deadline, cancel);
    let Some(text) =
        source::read_within(top, file).map_err(|e| format!("its file not read: {e}"))?
    else {
        return Ok(None);
    };
    let tree = parse_until(&text, until)?;
    let unit = ws.unit(file);
    let res = Resolver::new(&unit, &tree, &text);
    let Some(mut own) = paths::owner(&tree, &text, (line, name), &res) else {
        return Ok(None);
    };
    if ws.unread().is_some() && own.kind == Kind::Free {
        return Ok(None);
    }
    let reexported = Reexported::new(top, ws, until);
    let rx = |m: &paths::Item, n: &str| reexported.brings(m, n);
    if matches!(own.kind, Kind::Trait { .. }) {
        own.kind = Kind::Trait {
            impls: implemented(top, ws, (&own.at, &rx), until)?,
        };
    }
    let mut found = Found::default();
    let mut files = candidates(top, &own.words(), name, until)?;
    if own.kind == Kind::Free && files.len() > FREE_FILES_MAX {
        found.partial = Some(format!("{FREE_FILES_MAX} of {} files read", files.len()));
        files.sort_by_key(|f| std::cmp::Reverse(shared(f, file)));
        files.truncate(FREE_FILES_MAX);
    }
    let at = Reading {
        top,
        ws,
        own: (name, &own),
        rx: &rx,
        until,
    };
    for f in files {
        at.read(&f, &mut found)?;
        if found.hits.len() > HITS_MAX {
            return Err(super::Unfinished::Capped.to_string());
        }
    }
    Ok(Some(found))
}

/// `Err` once `deadline` has passed or `cancel` is.
fn in_time((deadline, cancel): Until<'_>) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err(STOPPED.into());
    }
    if Instant::now() >= deadline {
        return Err(out_of_time());
    }
    Ok(())
}

/// The syntax tree of `text`, its parse stopped once `deadline` passes or `cancel` is.
fn parse_until(text: &str, until: Until<'_>) -> Result<Tree, String> {
    in_time(until)?;
    let tree = paths::parse(text, &mut || in_time(until).is_err());
    in_time(until)?;
    tree.ok_or_else(|| "the Rust grammar could not be loaded".to_owned())
}

#[cfg(test)]
#[path = "structural_tests.rs"]
mod tests;
