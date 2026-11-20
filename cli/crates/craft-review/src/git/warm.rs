//! The change a review reads, in a partial clone (realm @nick/craft, node #548): craft's local
//! reads fetch nothing ([`super::git`]), so the blobs of the changed files the clone lacks are
//! fetched once, before the first read, by one `git diff` from the base run as craft's remote git
//! runs — detached, with no prompt, bounded in time and stopped with the run. A clone that is not
//! partial runs nothing more.

use std::path::Path;

use super::{Diff, GitError};
use crate::cancel::Cancel;
use crate::sources::Git;

/// [`super::read_diff`], the blobs it needs fetched first in a partial clone
/// ([`fetch_diff_objects`]); a blob still missing names why that fetch failed.
///
/// # Errors
/// As [`super::read_diff`].
pub fn read_diff(
    cwd: &Path,
    base: Option<&str>,
    scope: Option<&str>,
    cancel: &Cancel,
) -> Result<Diff, GitError> {
    let fetched = fetch_diff_objects(cwd, base, scope, cancel);
    super::read_diff(cwd, base, scope).map_err(|e| match (e, fetched) {
        (GitError::NotFetched { command, stderr }, Err(why)) => GitError::NotFetched {
            command,
            stderr: format!("{stderr} (craft's fetch of them failed: {why})"),
        },
        (e, _) => e,
    })
}

/// In a partial clone, the blobs of the files changed from `base`'s merge-base with `HEAD` to the
/// working tree (under `scope`) fetched from the promisor remote: `Ok(true)`; `Ok(false)` in a
/// clone that is not partial, where nothing runs. `git diff --numstat` reads both sides of every
/// changed file and git fetches the missing ones in one batch, printing a line a file.
pub(crate) fn fetch_diff_objects(
    cwd: &Path,
    base: Option<&str>,
    scope: Option<&str>,
    cancel: &Cancel,
) -> Result<bool, String> {
    if !partial(cwd) {
        return Ok(false);
    }
    let base = match base {
        Some(b) => b.to_owned(),
        None => super::default_base(cwd).map_err(|e| e.to_string())?,
    };
    let top = super::toplevel(cwd).map_err(|e| e.to_string())?;
    let at = top.display().to_string();
    let pathspec = scope.map(|s| format!(":(top,literal){s}"));
    let mut args = vec![
        "-C",
        &at,
        "diff",
        "--numstat",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--merge-base",
        &base,
        "--",
    ];
    args.extend(pathspec.as_deref());
    Git::prompt_free_in(&top)
        .stopped_by(cancel.clone())
        .run_lazy(&args)
        .map(|_| true)
}

/// Whether `cwd`'s repository is a partial clone: a promisor remote configured.
fn partial(cwd: &Path) -> bool {
    let keys = r"^(extensions\.partialclone|remote\..*\.promisor)$";
    super::git(cwd, &["config", "--get-regexp", keys]).is_ok_and(|found| {
        found
            .lines()
            .any(|l| !l.ends_with(" false") && !l.ends_with(" 0"))
    })
}

#[cfg(test)]
mod tests;
