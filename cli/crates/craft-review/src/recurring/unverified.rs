//! Unverified findings recurring across branches, apart from the confirmed groups; a finding whose
//! line changed since its run's head is set aside (realm @nick/craft, #636).

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use craft_store::js::{Js, JsString, Obj};

use super::groups::{self, Group};
use super::read::{Row, Run};
use super::{number, text};

/// Only the rows of groups already on two branches are held to their lines, then regrouped in
/// the runs' order; a row whose head this clone lacks is kept and counted unchecked.
pub(super) fn unverified(runs: &[Run], project: &Path) -> Js {
    let rows = || {
        runs.iter()
            .flat_map(|run| run.unverified.iter().map(move |row| (run, row)))
    };
    let candidates: HashSet<*const Row> = groups::grouped(rows())
        .iter()
        .flat_map(Group::rows)
        .collect();
    let mut lines = Lines {
        project,
        hunks: BTreeMap::new(),
    };
    let (mut changed, mut unchecked) = (0, 0);
    let kept: Vec<_> = rows()
        .filter(|(_, row)| candidates.contains(&std::ptr::from_ref(*row)))
        .filter(|(run, row)| match lines.changed(run, row) {
            Some(true) => {
                changed += 1;
                false
            }
            Some(false) => true,
            None => {
                unchecked += 1;
                true
            }
        })
        .collect();
    let (listed, cut) = groups::listed(&groups::grouped(kept));
    Js::Obj(
        Obj::new()
            .with("groups", Js::Arr(listed))
            .with("groupsCut", number(cut))
            .with("changed", number(changed))
            .with("unchecked", number(unchecked)),
    )
}

/// The empty `unverified` field of a store with nothing to read.
pub(super) fn none() -> Js {
    Js::Obj(
        Obj::new()
            .with("groups", Js::Arr(vec![]))
            .with("groupsCut", number(0))
            .with("changed", number(0))
            .with("unchecked", number(0)),
    )
}

/// A hunk's old-side `(start, count)`.
type Hunk = (u64, u64);

/// Old-side ranges of `git diff <head> HEAD` per head and file, `None` when git cannot tell.
struct Lines<'p> {
    project: &'p Path,
    hunks: BTreeMap<(JsString, JsString), Option<Vec<Hunk>>>,
}

impl Lines<'_> {
    fn changed(&mut self, run: &Run, row: &Row) -> Option<bool> {
        let project = self.project;
        let hunks = self
            .hunks
            .entry((run.head.clone(), row.file.clone()))
            .or_insert_with(|| diff(project, &run.head, &row.file));
        Some(covers(hunks.as_deref()?, row.line))
    }
}

fn diff(project: &Path, head: &JsString, file: &JsString) -> Option<Vec<Hunk>> {
    let head = head
        .as_str()
        .filter(|h| !h.is_empty() && !h.starts_with('-'))?;
    let file = text::parts(file)
        .iter()
        .map(|p| p.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?
        .join("/");
    let spec = format!(":(top,literal){file}");
    let args = [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--text",
        "--unified=0",
        head,
        "HEAD",
        "--",
        &spec,
    ];
    let out = crate::git::git(project, &args).ok()?;
    Some(out.lines().filter_map(hunk).collect())
}

/// The old side of a `@@ -start[,count] +… @@` line; a missing count is one line.
pub(super) fn hunk(line: &str) -> Option<Hunk> {
    let old = line.strip_prefix("@@ -")?.split(' ').next()?;
    let (start, count) = old.split_once(',').unwrap_or((old, "1"));
    Some((start.parse().ok()?, count.parse().ok()?))
}

/// Whether a hunk replaced or removed `line`; a row naming no line changed with any edit.
pub(super) fn covers(hunks: &[Hunk], line: u32) -> bool {
    let line = u64::from(line);
    if line == 0 {
        return !hunks.is_empty();
    }
    hunks
        .iter()
        .any(|&(start, count)| count > 0 && start <= line && line < start + count)
}
