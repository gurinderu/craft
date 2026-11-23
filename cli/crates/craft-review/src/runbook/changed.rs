//! Which changed Markdown files the runbook profile takes (realm @nick/craft, node #620): those
//! whose changed lines touch a step — an added or changed line that is one, or a pure deletion of a
//! command line. Each file is read from the working tree as a changed file is read elsewhere: a
//! regular file of bounded size reached through no link ([`crate::consumers::source`]). A file
//! that cannot be read, or a change whose lines cannot be read, is said in a note, never dropped
//! silently.

use std::collections::BTreeSet;
use std::path::Path;

use super::{command::runs_command, step_lines};
use crate::consumers::source::read_within;
use crate::gate::lines::{Lines, removals};

/// The files the runbook profile takes, and what the report says of those it could not judge.
#[derive(Debug, Default)]
pub(crate) struct Taken {
    pub files: BTreeSet<String>,
    pub notes: Vec<String>,
}

/// The change's lines: the added ones and the pure deletions' text, or `None` when unread.
struct Changed {
    lines: Lines,
    removed: Vec<(String, Vec<String>)>,
}

fn changed(cwd: &Path, merge_base: &str) -> Result<Changed, crate::git::GitError> {
    let diff = crate::git::zero_context_diff(cwd, merge_base)?;
    let removed = removals(&diff)
        .into_iter()
        .map(|r| (r.file, r.text))
        .collect();
    Ok(Changed {
        lines: Lines::parse(&diff),
        removed,
    })
}

impl Changed {
    /// Whether the change touches a step of `file`, whose steps are `steps`.
    fn touches(&self, file: &str, steps: &[u32]) -> bool {
        steps.iter().any(|n| self.lines.touches(file, *n))
            || self.removed.iter().any(|(f, text)| {
                f == file
                    && text
                        .iter()
                        .any(|l| !l.trim_start().starts_with('#') && runs_command(l))
            })
    }
}

/// Of `candidates`, the Markdown files the runbook profile may take by name, those whose change in
/// the checkout `cwd` is in, against `merge_base`, touches a step.
pub(crate) fn taken(cwd: &Path, merge_base: &str, candidates: &[String]) -> Taken {
    let mut out = Taken::default();
    if candidates.is_empty() {
        return out;
    }
    let top = crate::git::toplevel(cwd).unwrap_or_else(|e| {
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
        match read_within(&top, f) {
            Ok(None) => {}
            Ok(Some(text)) => {
                let steps = step_lines(&text);
                let touched = change.as_ref().map_or(!steps.is_empty(), |c| c.touches(f, &steps));
                if touched {
                    out.files.insert(f.clone());
                }
            }
            Err(e) => out.notes.push(format!(
                "{f} could not be read ({e}): whether its change touches a runbook step is unknown, \
                 and it was NOT reviewed by the runbook lens"
            )),
        }
    }
    out
}
