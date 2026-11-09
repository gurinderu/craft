//! What changed: the base a review measures against and the diff from it, read with `git`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

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
    /// The fingerprint of the tracked files' changes against `head` when the run started
    /// ([`worktree`]), so a resume refuses a tree changed since; empty in a state written before
    /// it, which then reads as before and keeps its format.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub worktree: String,
    /// Every changed path, repository-relative.
    pub files: Vec<String>,
    /// `git diff --stat`'s summary.
    pub stat: String,
    /// The commit messages from the merge-base to `HEAD`, newest first.
    pub log: String,
}

/// Runs `git` in `cwd` and returns its stdout.
pub(crate) fn git(cwd: &Path, args: &[&str]) -> Result<String, GitError> {
    String::from_utf8(git_bytes(cwd, args)?).map_err(GitError::NotUtf8)
}

/// Runs `git` in `cwd` and returns its stdout as bytes, whatever their encoding.
fn git_bytes(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
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
    Ok(out.stdout)
}

/// The fingerprint of the tracked files' changes against `HEAD` in the working tree `cwd` is in
/// (untracked ones aside, as [`Diff::dirty`]): sha256 of `git diff --binary HEAD` from the top
/// level, the same for the same changes whatever the files' encoding.
///
/// # Errors
/// When `cwd` is not in a working tree or `git` fails.
pub fn worktree(cwd: &Path) -> Result<String, GitError> {
    let top = toplevel(cwd)?;
    let args = [
        "diff",
        "--binary",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
    ];
    let digest = Sha256::digest(git_bytes(&top, &args)?);
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
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

/// Whether the code in `scope`, a repository-relative path, is unchanged since `commit`, the
/// working tree included, as `git diff --quiet <commit> -- <scope>` answers from the repository's
/// top level — a pathspec git reads from a subdirectory would name another path; false when git
/// cannot tell.
#[must_use]
pub fn unchanged_since(cwd: &Path, commit: &str, scope: &str) -> bool {
    let Ok(top) = toplevel(cwd) else {
        return false;
    };
    !commit.starts_with('-') && git(&top, &["diff", "--quiet", commit, "--", scope]).is_ok()
}

/// The change against `base` with no context lines, from the merge-base to the working tree, as
/// `git diff -U0 --merge-base <base>` prints it from the top level with its paths unquoted and
/// prefixed `a/` and `b/` whatever `diff.noprefix` or `diff.mnemonicPrefix` says.
///
/// # Errors
/// When `cwd` is not in a working tree or `git` fails.
pub fn zero_context_diff(cwd: &Path, base: &str) -> Result<String, GitError> {
    not_an_option(cwd, &[base])?;
    diff_u0(cwd, &["--merge-base", base])
}

/// The change from `from` to the commit `to` with no context lines, printed as
/// [`zero_context_diff`] prints it: from their merge-base when `merge_base`, else from `from`
/// itself.
///
/// # Errors
/// When `cwd` is not in a working tree or `git` fails.
pub fn zero_context_between(
    cwd: &Path,
    from: &str,
    to: &str,
    merge_base: bool,
) -> Result<String, GitError> {
    not_an_option(cwd, &[from, to])?;
    if merge_base {
        diff_u0(cwd, &["--merge-base", from, to])
    } else {
        diff_u0(cwd, &[from, to])
    }
}

/// Refuses a revision git would read as an option.
fn not_an_option(cwd: &Path, revs: &[&str]) -> Result<(), GitError> {
    match revs.iter().find(|r| r.starts_with('-')) {
        Some(r) => Err(GitError::NotACommit {
            base: (*r).to_owned(),
            repo: cwd.to_owned(),
        }),
        None => Ok(()),
    }
}

/// `git diff -U0` over `revs`, from the top level.
fn diff_u0(cwd: &Path, revs: &[&str]) -> Result<String, GitError> {
    let top = toplevel(cwd)?;
    let mut args = vec![
        "-c",
        "core.quotePath=false",
        "diff",
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ];
    args.extend_from_slice(revs);
    git(&top, &args)
}

/// Whether `commit` is `descendant` or an ancestor of it.
#[must_use]
pub fn holds(cwd: &Path, descendant: &str, commit: &str) -> bool {
    ![commit, descendant]
        .iter()
        .any(|c| c.is_empty() || c.starts_with('-'))
        && git(cwd, &["merge-base", "--is-ancestor", commit, descendant]).is_ok()
}

/// The top level of the working tree `cwd` is in.
///
/// # Errors
/// When `cwd` is not in a working tree or `git` fails.
pub fn toplevel(cwd: &Path) -> Result<PathBuf, GitError> {
    Ok(PathBuf::from(
        git(cwd, &["rev-parse", "--show-toplevel"])?.trim(),
    ))
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

/// Reads the change in `cwd` against `base`, or the remote default branch when `None`; with
/// `scope`, a repository-relative directory or file ([`crate::scope`]), only the files under it.
///
/// # Errors
/// When `cwd` is not a repository, the base does not resolve, or `git` fails.
pub fn read_diff(cwd: &Path, base: Option<&str>, scope: Option<&str>) -> Result<Diff, GitError> {
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
    let worktree = worktree(cwd)?;
    // `top`: read from the top level, so the scope names the same path from any subdirectory;
    // `literal`: a directory name is no glob.
    let pathspec = scope.map(|s| format!(":(top,literal){s}"));
    let limited = |args: &[&str]| {
        let mut all = args.to_vec();
        if let Some(p) = &pathspec {
            all.extend(["--", p.as_str()]);
        }
        git(cwd, &all)
    };
    let files = limited(&["diff", "--name-only", "--merge-base", &base])?
        .lines()
        .map(str::to_owned)
        .collect();
    let stat = limited(&["diff", "--stat", "--merge-base", &base])?;
    let log = git(cwd, &["log", "--format=%B", &format!("{merge_base}..HEAD")])?;
    Ok(Diff {
        base,
        merge_base,
        head,
        dirty,
        worktree,
        files,
        stat: stat.trim_end().to_owned(),
        log: log.trim().to_owned(),
    })
}

#[cfg(test)]
mod tests;
