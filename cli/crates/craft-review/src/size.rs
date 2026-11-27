//! The size of each part of the change, counted by the binary from the lines git says it changed,
//! not named by the scout (realm @nick/craft, node #655): the bucket that sets a plan's rounds and
//! verification votes is arithmetic, with one answer.

use std::collections::BTreeMap;
use std::path::Path;

use crate::git::Diff;
use crate::state::Track;

/// Fewer changed lines than this: a small change.
pub const SMALL_BELOW: u64 = 80;

/// More changed lines than this: a large change.
pub const LARGE_ABOVE: u64 = 400;

/// The profile whose size is counted in procedure steps, not lines: its scout still names it.
const BY_SCOUT: &str = "runbook";

/// The bucket of a part that changed `lines` lines, added and removed.
#[must_use]
pub fn bucket(lines: u64) -> &'static str {
    if lines < SMALL_BELOW {
        "small"
    } else if lines > LARGE_ABOVE {
        "large"
    } else {
        "medium"
    }
}

/// Whether the plan of `profile` takes its size from the lines counted (`false` for a profile
/// sized by its scout).
#[must_use]
pub fn counted(profile: &str) -> bool {
    profile != BY_SCOUT
}

/// The lines that set the size of `profile`'s part, `changed_lines` as counted: `None` when its
/// scout names the size instead — a profile sized by its scout, or lines git could not count.
#[must_use]
pub fn told(profile: &str, changed_lines: Option<u64>) -> Option<u64> {
    changed_lines.filter(|_| counted(profile))
}

/// The scout's answer schema for a part whose size `told` gave, or `None`: `sizeBucket` required
/// where the scout is the one to name it, so an answer without it is retried, not read as medium.
#[must_use]
pub fn scout_schema(mut schema: serde_json::Value, told: Option<u64>) -> serde_json::Value {
    let size = serde_json::Value::from("sizeBucket");
    if told.is_none()
        && let Some(required) = schema
            .get_mut("required")
            .and_then(serde_json::Value::as_array_mut)
        && !required.contains(&size)
    {
        required.insert(0, size);
    }
    schema
}

/// Each changed file's added and removed lines, by its new path, from `git diff --numstat -z`:
/// `added\tremoved\tpath\0`, or `added\tremoved\t\0old\0new\0` for a rename; a binary file, `-`
/// for both, changes no line.
fn parse(z: &str) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    let mut fields = z.split('\0');
    while let Some(head) = fields.next() {
        let mut parts = head.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = fields.next();
            fields.next().unwrap_or_default()
        } else {
            path
        };
        let n = |s: &str| s.parse::<u64>().unwrap_or(0);
        out.insert(path.to_owned(), n(added).saturating_add(n(removed)));
    }
    out
}

/// Marks each of `tracks` with the lines its files changed, as the checkout `cwd` shows the change
/// against its merge base. A change git cannot count leaves every track's count unknown — its plan
/// then takes the scout's size — and the note it returns says so for the report.
pub(crate) fn mark(cwd: &Path, diff: &Diff, tracks: &mut [Track]) -> Option<String> {
    let counted = crate::git::toplevel(cwd).and_then(|top| {
        crate::git::git(
            &top,
            &[
                "diff",
                "--numstat",
                "-z",
                "-M",
                "--merge-base",
                &diff.merge_base,
            ],
        )
    });
    let lines = match counted {
        Ok(z) => parse(&z),
        Err(e) => {
            for t in tracks.iter_mut() {
                t.changed_lines = None;
            }
            return Some(format!(
                "the change's lines could not be counted ({e}): each plan's size is the scout's"
            ));
        }
    };
    for t in tracks.iter_mut() {
        t.changed_lines = Some(t.files.iter().filter_map(|f| lines.get(f)).sum());
    }
    None
}

#[cfg(test)]
mod tests;
