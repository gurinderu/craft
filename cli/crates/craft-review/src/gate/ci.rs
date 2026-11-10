//! CI as the gate's evidence when its own build is impossible (realm @nick/craft, node #482): cargo
//! ended with no compiler error (a private registry without a token, say), so the gate reads the
//! reviewer's CI map (node #483) and what GitHub reports for the head. CI informs, it never
//! certifies: a green mapped check is reported and the track stays unknown; a red one fails it, a
//! Block like a local red; a pending or absent one gives no signal. An entry one of whose files
//! changed since it was confirmed, or whose command is no longer found in them, is skipped and the
//! map named stale. A working tree with uncommitted changes is not what CI built for its head, so
//! CI is not read. No map, no gh, no auth or no network: the gate stays as it was, with a note.

use super::check::{Acc, Cx};
use super::ci_read::seen;
use super::ci_verdict::{apply, unique, verdict};
use crate::project::ci::unexpanded;
use crate::project::{self, CiEntry};

const DIRTY: &str = "CI was not read: the working tree has uncommitted changes, so CI for HEAD does not cover it — the build signal stays unknown";
const NO_MAP: &str = "no CI map in the review profile, so the build signal stays unknown — `craft init --propose` proposes one";

/// Reads CI for the head and folds it into `acc`, whose build signal is unknown.
pub(super) fn from_ci(cx: &Cx<'_>, acc: &mut Acc) {
    let Some(projects) = cx.projects else {
        return;
    };
    let map = match map(projects, cx.top) {
        Ok(m) => m,
        Err(note) => return acc.notes.push(note),
    };
    let map = expanded(map, acc);
    let (fresh, stale): (Vec<&CiEntry>, Vec<&CiEntry>) = map.iter().partition(|e| e.fresh(cx.top));
    if !stale.is_empty() {
        acc.notes.push(stale_note(&stale, cx.top));
    }
    if fresh.is_empty() {
        return;
    }
    match crate::git::dirty(cx.top) {
        Ok(false) => {}
        Ok(true) => return acc.notes.push(DIRTY.to_owned()),
        Err(e) => {
            return acc
                .notes
                .push(format!("CI was not read: no tree status ({e})"));
        }
    }
    let head = match crate::git::git(cx.top, &["rev-parse", "HEAD"]) {
        Ok(h) => h.trim().to_owned(),
        Err(e) => {
            return acc
                .notes
                .push(format!("CI was not read: no head commit ({e})"));
        }
    };
    match seen(cx.runner, cx.top, &head) {
        Ok(s) => apply(acc, &verdict(&fresh, &s), head.get(..7).unwrap_or(&head)),
        Err(why) => acc.notes.push(format!(
            "CI was not read ({why}), so the build signal stays unknown"
        )),
    }
}

/// The entries of `map` a run can match: one whose check holds an unexpanded `${{ … }}` matches
/// none, so it is skipped and named in `acc`'s notes.
fn expanded(map: Vec<CiEntry>, acc: &mut Acc) -> Vec<CiEntry> {
    let (dead, live): (Vec<CiEntry>, Vec<CiEntry>) =
        map.into_iter().partition(|e| unexpanded(&e.check));
    for e in &dead {
        acc.notes.push(format!(
            "the CI map entry `{}` was skipped: its check name holds an unexpanded expression, which GitHub expands in each run's name, so no run matches it — run `craft init --propose` to confirm it again",
            e.check
        ));
    }
    live
}

/// The CI map of the repository at `top`, or the note why there is none to read.
fn map(projects: &std::path::Path, top: &std::path::Path) -> Result<Vec<CiEntry>, String> {
    let unread =
        |why: String| format!("the review profile could not be read ({why}): CI was not read");
    let (path, _) = project::profile_path(projects, top).map_err(|e| unread(e.to_string()))?;
    match project::load(&path) {
        Ok(Some(p)) if !p.ci.is_empty() => Ok(p.ci),
        Ok(_) => Err(NO_MAP.to_owned()),
        Err(e) => Err(unread(e.to_string())),
    }
}

fn stale_note(stale: &[&CiEntry], top: &std::path::Path) -> String {
    let changed: Vec<String> = stale
        .iter()
        .flat_map(|e| {
            let files = e.changed(top);
            match (files.is_empty(), e.unfound(top)) {
                (true, Some(why)) => vec![format!("the entry of {} ({why})", e.check)],
                _ => files,
            }
        })
        .collect();
    let files = unique(changed.iter().map(String::as_str));
    let checks = unique(stale.iter().map(|e| e.check.as_str()));
    format!(
        "the CI map is stale: {} changed since it was confirmed, so {} skipped — run `craft init --propose` to confirm it again",
        files.join(", "),
        checks.join(", ")
    )
}
