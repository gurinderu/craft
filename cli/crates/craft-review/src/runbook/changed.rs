//! Which changed Markdown files the runbook profile takes (realm @nick/craft, node #620): those
//! whose change touches a step on either side — an added or changed line on a step of the working
//! tree's version, or a changed or removed line on a step of the base's (a step replaced, disabled
//! or deleted, a shell block's info string flipped), a renamed file's base read and matched under
//! its old path. The working tree's version is read as a changed file is read elsewhere: a regular
//! file of bounded size reached through no link ([`crate::consumers::source`]); the base's from
//! git, under the same size cap. A file that cannot be read, or a change whose lines cannot be
//! read, is said in a note, never dropped silently.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::renamed::renames;
use super::step_lines;
use crate::consumers::source::read_within;
use crate::gate::lines::Lines;
use crate::git::{self, GitError};

/// The most of a base version read, as the changed-file reader caps the working tree's.
const BASE_MAX: u64 = 4 << 20;

/// The files the runbook profile takes, and what the report says of those it could not judge.
#[derive(Debug, Default)]
pub(crate) struct Taken {
    pub files: BTreeSet<String>,
    /// The old path of each taken file the change renamed, by its new path: the lens reads both.
    pub renamed: BTreeMap<String, String>,
    pub notes: Vec<String>,
}

/// The change's lines on both sides: the new side's added or changed, the old side's changed or
/// removed.
struct Changed {
    new: Lines,
    old: Lines,
    /// Each renamed file's old path, by its new one.
    renamed: BTreeMap<String, String>,
}

fn changed(cwd: &Path, merge_base: &str) -> Result<Changed, GitError> {
    let diff = git::zero_context_diff(cwd, merge_base)?;
    Ok(Changed {
        new: Lines::parse(&diff),
        old: Lines::parse_old(&diff),
        renamed: renames(&diff),
    })
}

/// `path` as the commit `rev` holds it, `None` when it holds none; refused over [`BASE_MAX`].
fn at_base(cwd: &Path, rev: &str, path: &str) -> Result<Option<String>, String> {
    let spec = format!("{rev}:{path}");
    let listed =
        git::git(cwd, &["ls-tree", "--name-only", rev, "--", path]).map_err(|e| e.to_string())?;
    if listed.trim().is_empty() {
        return Ok(None);
    }
    let size = git::git(cwd, &["cat-file", "-s", &spec]).map_err(|e| e.to_string())?;
    fits(&size)?;
    git::git(cwd, &["cat-file", "blob", &spec])
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Whether a blob of the size `git cat-file -s` printed is within [`BASE_MAX`].
fn fits(size: &str) -> Result<(), String> {
    match size.trim().parse::<u64>() {
        Ok(n) if n <= BASE_MAX => Ok(()),
        Ok(_) => Err(format!("larger than {BASE_MAX} bytes at the base")),
        Err(_) => Err(format!(
            "git printed no size for it at the base: {:?}",
            size.trim()
        )),
    }
}

/// Whether `file`'s change touches a step of either version: `new` the working tree's text,
/// `old` the base's, held at `was` (each `None` when that side holds no file).
fn touches(
    change: Option<&Changed>,
    (file, was): (&str, &str),
    (new, old): (Option<&str>, Option<&str>),
) -> bool {
    let new_steps = new.map(step_lines).unwrap_or_default();
    let Some(c) = change else {
        return !new_steps.is_empty();
    };
    let old_steps = old.map(step_lines).unwrap_or_default();
    new_steps.iter().any(|n| c.new.touches(file, *n))
        || old_steps.iter().any(|n| c.old.touches(was, *n))
}

/// Of `candidates`, the Markdown files the runbook profile may take by name, those whose change in
/// the checkout `cwd` is in, against `merge_base`, touches a step.
pub(crate) fn taken(cwd: &Path, merge_base: &str, candidates: &[String]) -> Taken {
    let mut out = Taken::default();
    if candidates.is_empty() {
        return out;
    }
    let top = git::toplevel(cwd).unwrap_or_else(|e| {
        out.notes.push(format!(
            "the runbook signal could not find the repository's top ({e}): Markdown files were read from {}",
            cwd.display()
        ));
        cwd.to_path_buf()
    });
    let change = changed(cwd, merge_base)
        .map_err(|e| {
            out.notes.push(format!(
                "the runbook signal could not read the changed lines ({e}): a changed Markdown file \
                 holding any step was given the runbook lens"
            ));
        })
        .ok();
    for f in candidates {
        let new = read_within(&top, f).map_err(|e| e.to_string());
        // Without the change's lines the base is not needed: any step of the file buys the lens.
        let was = change
            .as_ref()
            .and_then(|c| c.renamed.get(f))
            .map_or(f.as_str(), String::as_str);
        let old = match change {
            Some(_) => at_base(&top, merge_base, was),
            None => Ok(None),
        };
        match (new, old) {
            (Ok(new), Ok(old)) => {
                if touches(change.as_ref(), (f, was), (new.as_deref(), old.as_deref())) {
                    out.files.insert(f.clone());
                    if was != f {
                        out.renamed.insert(f.clone(), was.to_owned());
                    }
                }
            }
            (Err(e), _) | (_, Err(e)) => {
                let named = if was == f {
                    f.clone()
                } else {
                    format!("{f} (at the base {was})")
                };
                out.notes.push(format!(
                    "{named} could not be read ({e}): whether its change touches a runbook step is \
                     unknown, and it was NOT reviewed by the runbook lens"
                ));
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "changed_tests.rs"]
mod tests;
