//! Each changed file's lines as a function-context diff shows them — added, removed and the
//! function around them — read from git's text alone: no file of the working tree is opened, so a
//! symlink, a FIFO or a huge file cannot stall the review (realm @nick/craft, node #625).

use std::collections::BTreeMap;

use crate::gate::lines::header_path;

/// One file's part of the diff.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct FileChange {
    /// The change adds the file.
    pub new: bool,
    /// Its hunks' lines, each with its position, hunks set apart by more than a loop body;
    /// `None` when git shows no text for it (a binary file).
    pub lines: Option<Vec<(u32, String)>>,
    /// How many lines the change adds to it.
    pub added: usize,
    /// How many of those added lines introduce a branch (`if`/`else`/`match`/`for`/`while`/`loop`).
    pub branches: usize,
}

/// The gap between two hunks' positions: a loop opening in one never reaches into the next.
const HUNK_GAP: u32 = 100;

/// Each file of `diff`, by its new path (its old one when the change deletes it).
pub(crate) fn parse(diff: &str) -> BTreeMap<String, FileChange> {
    let mut out = BTreeMap::new();
    let mut at: Option<(Option<String>, FileChange)> = None;
    let (mut in_header, mut pos) = (false, 0u32);
    let mut flush = |at: &mut Option<(Option<String>, FileChange)>| {
        if let Some((Some(path), change)) = at.take() {
            out.insert(path, change);
        }
    };
    for l in diff.lines() {
        if l.starts_with("diff --git ") {
            flush(&mut at);
            at = Some((git_line_path(l), FileChange::default()));
            in_header = true;
            continue;
        }
        let Some((path, change)) = at.as_mut() else {
            continue;
        };
        if in_header {
            // A file's positions are its own: its first hunk needs no gap.
            header(l, path, change);
            in_header = !l.starts_with("@@ ");
        } else if l.starts_with("@@ ") {
            pos += HUNK_GAP;
        } else if let Some(text) = l.strip_prefix(['+', '-', ' ']) {
            pos += 1;
            if l.starts_with('+') {
                change.added += 1;
                change.branches += usize::from(super::words::is_branch(text));
            }
            change
                .lines
                .get_or_insert_with(Vec::new)
                .push((pos, text.to_owned()));
        }
    }
    flush(&mut at);
    out
}

/// What a header line says of its file. A text file's header shows its paths, a mode, a rename or
/// its first hunk, any of which makes its lines known; a binary one's says so, leaving them unknown.
fn header(l: &str, path: &mut Option<String>, change: &mut FileChange) {
    if l.starts_with("Binary files ") {
        change.lines = None;
        return;
    }
    let known = [
        "new file mode ",
        "deleted file mode ",
        "new mode ",
        "rename to ",
        "--- ",
        "+++ ",
        "@@ ",
    ];
    if known.iter().any(|k| l.starts_with(k)) {
        change.lines.get_or_insert_with(Vec::new);
    }
    if l.starts_with("new file mode ") {
        change.new = true;
    } else if let Some(rest) = l.strip_prefix("--- ") {
        *path = header_path(rest, "a/");
    } else if let Some(p) = l.strip_prefix("+++ ").and_then(|r| header_path(r, "b/")) {
        *path = Some(p);
    } else if let Some(p) = l.strip_prefix("rename to ") {
        *path = Some(p.to_owned());
    }
}

/// The new path a `diff --git a/x b/x` line names, unquoted: what a header without `---`/`+++`
/// lines (a mode change, an empty file) is known by.
fn git_line_path(l: &str) -> Option<String> {
    l.rsplit_once(" b/").map(|(_, p)| p.to_owned())
}
