//! The changed Rust files of a change walked for their symbols: each file read once, its added
//! lines and its pure deletions mapped to the items they change, every symbol past the limit and
//! every file not read named.

use std::collections::BTreeSet;
use std::path::Path;

use super::removed::of_removals;
use super::source::read;
use super::symbols::{Symbol, add, is_test_path, of_file};
use crate::gate::lines::{Lines, Removal};

/// What [`changed`] found: the symbols, each `(file, name)` once and at most the limit; the
/// changed code lines (`file:line`) in no item; the symbols past the limit (`name (file)`); the
/// changed Rust files not read (`file (why)`).
#[derive(Debug, Default)]
pub(super) struct Changed {
    pub symbols: Vec<Symbol>,
    pub unplaced: Vec<String>,
    pub unlisted: Vec<String>,
    pub unreadable: Vec<String>,
}

/// The symbols the change adds or changes — its added `lines`, and the lines it only `removed` —
/// in the Rust files of `files` under `top`, at most `max`, the rest named.
pub(super) fn changed(
    top: &Path,
    files: &[String],
    lines: &Lines,
    removed: &[Removal],
    max: usize,
) -> Changed {
    let mut out = Changed::default();
    let touched: BTreeSet<&str> = lines
        .ranges()
        .map(|(f, _)| f)
        .chain(removed.iter().map(|r| r.file.as_str()))
        .collect();
    for file in touched {
        if !file.ends_with(".rs") || is_test_path(file) || !files.iter().any(|f| f == file) {
            continue;
        }
        let text = match read(&top.join(file)) {
            Ok(text) => text,
            Err(why) => {
                out.unreadable.push(format!("{file} ({why})"));
                continue;
            }
        };
        let ranges = lines
            .ranges()
            .find(|(f, _)| *f == file)
            .map_or(&[][..], |r| r.1);
        let (mut found, lost) = of_file(file, &text, ranges);
        out.unplaced
            .extend(lost.into_iter().map(|n| format!("{file}:{n}")));
        let theirs: Vec<&Removal> = removed.iter().filter(|r| r.file == file).collect();
        let (more, lost) = of_removals(file, &text, &theirs);
        for s in more {
            add(&mut found, s);
        }
        out.unplaced.extend(lost);
        out.symbols.extend(found);
    }
    let past = out.symbols.split_off(max.min(out.symbols.len()));
    out.unlisted = past
        .iter()
        .map(|s| format!("{} ({})", s.name, s.file))
        .collect();
    out
}
