//! What changed: the base a review measures against and the diff from it, read with `git`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// Why the change could not be read.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("running git")]
    Spawn(#[source] std::io::Error),
    #[error("git {command} failed: {stderr}")]
    Failed { command: String, stderr: String },
    #[error("git printed non-UTF-8 output")]
    NotUtf8(#[source] std::string::FromUtf8Error),
    #[error(
        "no base given and origin has no default branch (origin/HEAD, origin/main, origin/master)"
    )]
    NoDefaultBase,
    #[error("the base {base} is not a commit in {}", repo.display())]
    NotACommit { base: String, repo: PathBuf },
}

/// The change under review: from the merge-base of `base` and `HEAD` to the working tree, as the
/// lens prompts' `git diff --merge-base <base>` shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// The ref the change is measured against, as given or as found.
    pub base: String,
    /// The commit `git merge-base <base> HEAD` names.
    pub merge_base: String,
    /// The commit `HEAD` named when the run started.
    pub head: String,
    /// Whether tracked files differed from `HEAD` when the run started (untracked ones aside): the
    /// review then read uncommitted work, which `head` alone does not name.
    pub dirty: bool,
    /// Every changed path, repository-relative.
    pub files: Vec<String>,
    /// `git diff --stat`'s summary.
    pub stat: String,
    /// The commit messages from the merge-base to `HEAD`, newest first.
    pub log: String,
}

/// Runs `git` in `cwd` and returns its stdout.
fn git(cwd: &Path, args: &[&str]) -> Result<String, GitError> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(GitError::Spawn)?;
    if !out.status.success() {
        return Err(GitError::Failed {
            command: args.join(" "),
            stderr: String::from_utf8_lossy(&out.stderr).trim().to_owned(),
        });
    }
    String::from_utf8(out.stdout).map_err(GitError::NotUtf8)
}

/// The branch `HEAD` is on, `None` on a detached `HEAD` (`git rev-parse --abbrev-ref` prints
/// `HEAD`) or when git cannot say, as `branchFromAbbrevRef`.
#[must_use]
pub fn branch(cwd: &Path) -> Option<String> {
    let name = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let name = name.trim();
    (!name.is_empty() && name != "HEAD").then(|| name.to_owned())
}

/// The repository's shared git directory, one for a checkout and all its linked worktrees, so the
/// worktrees of one repository share their review rounds as `repoKey` lets them.
///
/// # Errors
/// When `cwd` is not a repository or `git` fails.
pub fn common_dir(cwd: &Path) -> Result<String, GitError> {
    let dir = git(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    Ok(dir.trim().to_owned())
}

/// Whether `commit` is `HEAD` or an ancestor of it: a rebase or a force-push leaves it off.
#[must_use]
pub fn is_ancestor(cwd: &Path, commit: &str) -> bool {
    !commit.is_empty()
        && !commit.starts_with('-')
        && git(cwd, &["merge-base", "--is-ancestor", commit, "HEAD"]).is_ok()
}

/// Whether this repository has `commit`: a squash-merged branch or another clone may not.
#[must_use]
pub fn has_commit(cwd: &Path, commit: &str) -> bool {
    !commit.starts_with('-') && verifies(cwd, commit)
}

/// Whether the code in `scope` is unchanged since `commit`, the working tree included, as
/// `git diff --quiet <commit> -- <scope>` answers; false when git cannot tell.
#[must_use]
pub fn unchanged_since(cwd: &Path, commit: &str, scope: &str) -> bool {
    !commit.starts_with('-') && git(cwd, &["diff", "--quiet", commit, "--", scope]).is_ok()
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
/// [`GitError::NoDefaultBase`] when none of them exists.
pub fn default_base(cwd: &Path) -> Result<String, GitError> {
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
        .ok_or(GitError::NoDefaultBase)
}

/// Reads the change in `cwd` against `base`, or the remote default branch when `None`.
///
/// # Errors
/// When `cwd` is not a repository, the base does not resolve, or `git` fails.
pub fn read_diff(cwd: &Path, base: Option<&str>) -> Result<Diff, GitError> {
    let base = match base {
        Some(b) => b.to_owned(),
        None => default_base(cwd)?,
    };
    if base.starts_with('-') || !verifies(cwd, &base) {
        return Err(GitError::NotACommit {
            base,
            repo: cwd.to_owned(),
        });
    }
    let merge_base = git(cwd, &["merge-base", &base, "HEAD"])?.trim().to_owned();
    let head = git(cwd, &["rev-parse", "HEAD"])?.trim().to_owned();
    let dirty = !git(cwd, &["status", "--porcelain", "--untracked-files=no"])?
        .trim()
        .is_empty();
    let files = git(cwd, &["diff", "--name-only", "--merge-base", &base])?
        .lines()
        .map(str::to_owned)
        .collect();
    let stat = git(cwd, &["diff", "--stat", "--merge-base", &base])?;
    let log = git(cwd, &["log", "--format=%B", &format!("{merge_base}..HEAD")])?;
    Ok(Diff {
        base,
        merge_base,
        head,
        dirty,
        files,
        stat: stat.trim_end().to_owned(),
        log: log.trim().to_owned(),
    })
}
