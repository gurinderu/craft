//! The mechanical re-anchor step between the dedup and the verification panel, with no model call
//! (realm @nick/craft, node #547): a finding whose line cannot be where its symbol is — the line is
//! past the end of the head file — while the one item its `symbol` names stands in that file on
//! exactly one line, is moved to that line, and keeps the line it came with as `lineFrom` for the
//! report. A symbol on several lines or on none, a line inside the file, a gate tool's seed, a
//! file-level finding, a path that would leave the repository and a file not readable as text all
//! leave the finding as it is. It runs after the dedup, before the verification tasks are built:
//! no finding id is stored, the dedup's keys are spent, and the verifier, the ledger row and a PR
//! comment all read the corrected line.

mod tree;

use serde_json::Value;

use crate::state::RunState;
pub(crate) use tree::{Blob, GitTree, Tree};

/// The field a moved finding carries: the line it was reported at.
pub(crate) const FIELD: &str = "lineFrom";

/// The shortest name the step looks up: a shorter one stands in too many places to anchor.
const MIN_NAME: usize = 3;

fn text<'a>(f: &'a Value, k: &str) -> &'a str {
    f.get(k).and_then(Value::as_str).unwrap_or("")
}

/// The line `f` was reported at, when the step moved it.
pub(crate) fn moved_from(f: &Value) -> Option<i64> {
    f.get(FIELD).and_then(Value::as_i64)
}

/// Whether a gate tool reported `f`: the tool anchored it, so it stays.
fn is_seed(f: &Value) -> bool {
    let tool = |s: &Value| s.as_str().is_some_and(crate::tool::is_tool_source);
    f.get("sources")
        .and_then(Value::as_array)
        .is_some_and(|a| a.iter().any(tool))
        || f.get("source").is_some_and(tool)
}

/// `file` as a path from the repository's top `root`, or `None` when it would leave it: an
/// absolute path outside `root`, one with a `..`, `.` or empty component, or one `git` would read
/// as pathspec magic.
pub(crate) fn within(file: &str, root: &str) -> Option<String> {
    let file = file.strip_prefix("./").unwrap_or(file);
    let rel = if file.starts_with('/') {
        file.strip_prefix(root.trim_end_matches('/'))?
            .strip_prefix('/')?
    } else {
        file
    };
    let clean = !rel.starts_with(':')
        && rel
            .split('/')
            .all(|c| !c.is_empty() && c != "." && c != "..");
    clean.then(|| rel.to_owned())
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The name `symbol` points at — the last segment of one path (`Type::method`, `fn parse`,
/// `a.b()`) — or `None` when it names several items (`a / b`, `a, b`) or none long enough.
fn name_of(symbol: &str) -> Option<&str> {
    if symbol.contains(['/', ',', '|', ';']) {
        return None;
    }
    symbol
        .split(|c: char| !is_ident(c))
        .rfind(|w| w.chars().count() >= MIN_NAME)
}

/// Whether `word` stands in `line` as a whole identifier.
fn has_word(line: &str, word: &str) -> bool {
    line.match_indices(word).any(|(at, _)| {
        let before = line.get(..at).and_then(|s| s.chars().next_back());
        let after = line.get(at + word.len()..).and_then(|s| s.chars().next());
        !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
    })
}

/// The one line (1-based) of `t` that `word` stands on, `None` when it stands on several or none.
fn only_line(t: &str, word: &str) -> Option<usize> {
    let mut hits = t
        .lines()
        .enumerate()
        .filter(|(_, l)| has_word(l, word))
        .map(|(i, _)| i + 1);
    let first = hits.next()?;
    hits.next().is_none().then_some(first)
}

/// The line `f` belongs at, or `None` when it stays; `root` is the repository's top.
pub(crate) fn target(f: &Value, root: &str, tree: &dyn Tree) -> Option<i64> {
    let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
    let file = text(f, "file");
    if line <= 0 || file.is_empty() || is_seed(f) {
        return None;
    }
    let name = name_of(text(f, "symbol"))?;
    let path = within(file, root)?;
    let Blob::Text(t) = tree.at_head(&path) else {
        return None;
    };
    // Only a line that cannot be the symbol's site moves: one inside the file may sit in the
    // symbol's body, where the finding is better placed than at its definition.
    if usize::try_from(line).is_ok_and(|l| l <= t.lines().count()) {
        return None;
    }
    i64::try_from(only_line(&t, name)?).ok()
}

/// Moves the run's findings to their symbol's line, before verification, and the note that lists
/// them; none on a tree with uncommitted changes, whose files the head does not hold.
pub(crate) fn reanchor(run: &mut RunState) -> Vec<String> {
    if run.diff.dirty {
        return vec!["the mechanical re-anchor step did not run: the tree had uncommitted changes, which the head commit does not hold".into()];
    }
    let tree = GitTree::new(&run.context.repo, &run.diff.head);
    reanchor_with(run, &tree)
}

/// [`reanchor`] against `tree`.
pub(crate) fn reanchor_with(run: &mut RunState, tree: &dyn Tree) -> Vec<String> {
    let root = run.context.repo.clone();
    let mut listed = Vec::new();
    for f in &mut run.findings {
        let Some(to) = target(f, &root, tree) else {
            continue;
        };
        let from = f.get("line").and_then(Value::as_i64).unwrap_or(0);
        listed.push(format!("`{}:{from}` → line {to}", text(f, "file")));
        if let Some(o) = f.as_object_mut() {
            o.insert(FIELD.into(), from.into());
            o.insert("line".into(), to.into());
        }
    }
    if listed.is_empty() {
        return Vec::new();
    }
    vec![format!(
        "{} finding(s) moved to the line of the symbol they name, before verification (their line was past the file's end): {}",
        listed.len(),
        listed.join("; ")
    )]
}

#[cfg(test)]
mod tests;
