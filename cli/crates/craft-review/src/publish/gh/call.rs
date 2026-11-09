//! One `gh` call, bounded by the posting budget: its stdout, or how it failed.

use std::path::Path;

use crate::gate::runner::{Ran, Runner};

/// Runs `gh args` in `repo`: its stdout, or why it gave none.
pub(in crate::publish) fn gh(
    runner: &Runner,
    repo: &Path,
    args: &[&str],
) -> Result<String, String> {
    gh_said(runner, repo, args).map_err(|f| f.why)
}

/// How a gh call failed: one line for the outcome, and the stderr it printed, whole up to
/// [`STDERR_KEPT`] bytes, for telling one failure from another — gh may name the HTTP status on a
/// later line than its first.
pub(in crate::publish) struct Failed {
    pub(in crate::publish) why: String,
    pub(in crate::publish) stderr: String,
}

/// How much of a failed call's stderr is kept to classify it.
const STDERR_KEPT: usize = 8192;

/// [`gh`], a failure with the stderr it printed.
pub(in crate::publish) fn gh_said(
    runner: &Runner,
    repo: &Path,
    args: &[&str],
) -> Result<String, Failed> {
    let what = args.iter().take(2).copied().collect::<Vec<_>>().join(" ");
    let plain = |why: String| Failed {
        why,
        stderr: String::new(),
    };
    match runner.run(repo, "gh", args) {
        Ran::Exited { ok: true, out, .. } => Ok(out),
        Ran::Exited { err, .. } => {
            let mut end = err.len().min(STDERR_KEPT);
            while !err.is_char_boundary(end) {
                end -= 1;
            }
            Err(Failed {
                why: format!(
                    "gh {what} failed: {}",
                    err.lines().next().unwrap_or("no message").trim()
                ),
                stderr: err.get(..end).unwrap_or_default().to_owned(),
            })
        }
        Ran::Missing => Err(plain("gh is not installed (no `gh` on the PATH)".into())),
        Ran::TimedOut(_) => Err(plain(format!(
            "gh {what} did not finish within the posting budget"
        ))),
        Ran::Broken(e) => Err(plain(format!("gh {what} could not run: {e}"))),
    }
}
