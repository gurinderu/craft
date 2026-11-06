//! What changed: the base a review measures against and the diff from it, read with `git`.

use std::path::Path;
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

/// The change under review: from the merge-base of `base` and `HEAD` to the working tree, as the
/// lens prompts' `git diff --merge-base <base>` shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// The ref the change is measured against, as given or as found.
    pub base: String,
    /// The commit `git merge-base <base> HEAD` names.
    pub merge_base: String,
    /// Every changed path, repository-relative.
    pub files: Vec<String>,
    /// `git diff --stat`'s summary.
    pub stat: String,
    /// The commit messages from the merge-base to `HEAD`, newest first.
    pub log: String,
}

/// Runs `git` in `cwd` and returns its stdout.
fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .context("running git")?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        bail!("git {} failed: {}", args.join(" "), err.trim());
    }
    String::from_utf8(out.stdout).context("git printed non-UTF-8 output")
}

fn verifies(cwd: &Path, rev: &str) -> bool {
    git(
        cwd,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
    )
    .is_ok()
}

/// The remote default branch: what `origin/HEAD` points at, else `origin/main` or `origin/master`.
///
/// # Errors
/// When none of them exists.
pub fn default_base(cwd: &Path) -> Result<String> {
    if let Ok(head) = git(
        cwd,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    ) {
        let head = head.trim();
        if !head.is_empty() && verifies(cwd, head) {
            return Ok(head.to_owned());
        }
    }
    ["origin/main", "origin/master"]
        .into_iter()
        .find(|r| verifies(cwd, r))
        .map(str::to_owned)
        .context("no base given and origin has no default branch (origin/HEAD, origin/main, origin/master)")
}

/// Reads the change in `cwd` against `base`, or the remote default branch when `None`.
///
/// # Errors
/// When `cwd` is not a repository, the base does not resolve, or `git` fails.
pub fn read_diff(cwd: &Path, base: Option<&str>) -> Result<Diff> {
    let base = match base {
        Some(b) => b.to_owned(),
        None => default_base(cwd)?,
    };
    if base.starts_with('-') || !verifies(cwd, &base) {
        bail!("the base {base} is not a commit in {}", cwd.display());
    }
    let merge_base = git(cwd, &["merge-base", &base, "HEAD"])?.trim().to_owned();
    let files = git(cwd, &["diff", "--name-only", "--merge-base", &base])?
        .lines()
        .map(str::to_owned)
        .collect();
    let stat = git(cwd, &["diff", "--stat", "--merge-base", &base])?;
    let log = git(cwd, &["log", "--format=%B", &format!("{merge_base}..HEAD")])?;
    Ok(Diff {
        base,
        merge_base,
        files,
        stat: stat.trim_end().to_owned(),
        log: log.trim().to_owned(),
    })
}
