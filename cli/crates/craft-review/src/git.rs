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
    #[error(
        "git {command} needs objects this partial clone does not have, and craft fetches none \
         itself: {stderr} — fetch them (run `git {command}` in your shell, or `git backfill`) \
         and review again"
    )]
    NotFetched { command: String, stderr: String },
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
///
/// Local only: in a partial clone git would fetch an object it lacks from the promisor remote
/// itself, here with no detach and no time limit, so the lazy fetch is off
/// (`GIT_NO_LAZY_FETCH=1`, observed on git 2.54; a git that predates it ignores it) and a
/// missing object fails the call as [`GitError::NotFetched`]; craft's no-prompt environment on
/// top, for an older git that fetches anyway. A review fetches what its diff needs first, through
/// the guarded path ([`warm`]) (realm @nick/craft, node #548).
fn git_bytes(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_NO_LAZY_FETCH", "1");
    crate::cancel::no_prompt_env(&mut cmd);
    let out = cmd.output().map_err(GitError::Spawn)?;
    if !out.status.success() {
        let command = args.join(" ");
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        return Err(if not_fetched(&stderr) {
            GitError::NotFetched { command, stderr }
        } else {
            GitError::Failed { command, stderr }
        });
    }
    Ok(out.stdout)
}

/// Whether git failed for an object a partial clone lacks and would have to fetch.
fn not_fetched(stderr: &str) -> bool {
    stderr.contains("lazy fetching disabled") || stderr.contains("from promisor remote")
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

/// `git merge-base <a> <b>`.
///
/// # Errors
/// When either is no commit (one spelled as an option included), they share no history, or `git`
/// fails.
pub fn merge_base(cwd: &Path, a: &str, b: &str) -> Result<String, GitError> {
    if let Some(bad) = [a, b].into_iter().find(|r| r.starts_with('-')) {
        return Err(GitError::NotACommit {
            base: bad.to_owned(),
            repo: cwd.to_owned(),
        });
    }
    Ok(git(cwd, &["merge-base", a, b])?.trim().to_owned())
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

/// The trunk: origin's default branch as [`default_base`] resolves it (`origin/HEAD` when it names
/// a commit, else `origin/main`, else `origin/master`); `None` when none resolves.
#[must_use]
pub fn trunk(cwd: &Path) -> Option<String> {
    let trunk = default_base(cwd).ok()?;
    not_an_option(cwd, &[&trunk]).ok()?;
    Some(trunk)
}

/// The last commit on `tip`'s first-parent line committed before `day` (`YYYY-MM-DD`) began
/// anywhere, at 00:00 +14:00, as `git rev-list -1 --first-parent --before='<day> 00:00:00 +1400'
/// <tip>` names it; `None` when that line starts after it.
///
/// # Errors
/// When `tip` is spelled as an option or `git` fails.
pub fn last_before(cwd: &Path, tip: &str, day: &str) -> Result<Option<String>, GitError> {
    not_an_option(cwd, &[tip])?;
    let before = format!("--before={day} 00:00:00 +1400");
    let out = git(cwd, &["rev-list", "-1", "--first-parent", &before, tip])?;
    let commit = out.trim();
    Ok((!commit.is_empty()).then(|| commit.to_owned()))
}

/// The commit on `tip`'s first-parent line that merged pull request `pr`, from `git log
/// --first-parent --no-show-signature --format='%H %s' <tip>`: the newest whose subject is GitHub's
/// `Merge pull request #<pr> from …`, else the oldest whose subject ends `(#<pr>)` — the squash
/// itself, not a later commit citing the PR; `None` when none does (realm @nick/craft, node #682).
///
/// # Errors
/// When `tip` is spelled as an option or `git` fails.
pub fn merge_of(cwd: &Path, tip: &str, pr: u64) -> Result<Option<String>, GitError> {
    not_an_option(cwd, &[tip])?;
    let args = [
        "log",
        "--first-parent",
        "--no-show-signature",
        "--format=%H %s",
        tip,
    ];
    let out = git_bytes(cwd, &args)?;
    let (merged, squashed) = (
        format!("Merge pull request #{pr} from "),
        format!("(#{pr})"),
    );
    let text = String::from_utf8_lossy(&out);
    let rows = text.lines().filter_map(|l| {
        let (hash, subject) = l.split_once(' ')?;
        hash.bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            .then_some((hash, subject))
    });
    let (mut by_merge, mut by_squash) = (None, None);
    for (hash, subject) in rows {
        if by_merge.is_none() && subject.starts_with(&merged) {
            by_merge = Some(hash.to_owned());
        } else if subject.ends_with(&squashed) {
            by_squash = Some(hash.to_owned());
        }
    }
    Ok(by_merge.or(by_squash))
}

/// The URL of the `origin` remote, lower-cased, as `git remote get-url origin` prints it; `None`
/// when there is none.
#[must_use]
pub fn origin_url(cwd: &Path) -> Option<String> {
    let url = git(cwd, &["remote", "get-url", "origin"]).ok()?;
    Some(url.trim_end_matches('\n').to_ascii_lowercase())
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

/// Whether the code in `scope` is unchanged on the trunk from `from` to the first parent of
/// `merge`, as `git diff --quiet <from>...<merge>^1 -- <scope>` answers from the top level: diffed
/// from their merge-base, so nothing lies between when `from` is `merge` or after it; false when
/// git cannot tell, or `from` is spelled as an option, which would spell the whole range as one
/// (realm @nick/craft, node #682).
#[must_use]
pub fn unchanged_before_merge(cwd: &Path, from: &str, merge: &str, scope: &str) -> bool {
    let Ok(top) = toplevel(cwd) else {
        return false;
    };
    let range = format!("{from}...{merge}^1");
    !from.starts_with('-') && git(&top, &["diff", "--quiet", &range, "--", scope]).is_ok()
}

/// The change against `base` with no context lines, from the merge-base to the working tree, as
/// `git diff -U0 --merge-base <base>` prints it from the top level with its paths unquoted and
/// prefixed `a/` and `b/` whatever `diff.noprefix` or `diff.mnemonicPrefix` says, renames found
/// whatever `diff.renames` says (`-M`), as the changed files are listed.
///
/// # Errors
/// When `cwd` is not in a working tree or `git` fails.
pub fn zero_context_diff(cwd: &Path, base: &str) -> Result<String, GitError> {
    not_an_option(cwd, &[base])?;
    diff_u0(cwd, &["--merge-base", base])
}

/// The change against `base` as [`zero_context_diff`] prints it, with git's default context and
/// its paths from `relative`, a repository-relative directory ('' for the top level): what
/// cargo-mutants reads its mutants of the change from, its paths from the workspace's root
/// (realm @nick/craft, node #624).
///
/// # Errors
/// When `cwd` is not in a working tree or `git` fails.
pub fn relative_diff(cwd: &Path, base: &str, relative: &str) -> Result<String, GitError> {
    not_an_option(cwd, &[base])?;
    let rel = format!("--relative={}/", relative.trim_end_matches('/'));
    let mut revs = vec!["--merge-base", base];
    if !relative.is_empty() {
        revs.insert(0, &rel);
    }
    diff_with(cwd, "-U3", &revs)
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
    diff_with(cwd, "-U0", revs)
}

/// The change since the merge-base of HEAD and `base`, working tree included, each hunk widened to
/// the whole function around it (`-W`), headers as [`zero_context_diff`] prints them: what the lens
/// signals read, so an edit inside an existing lock region or money path shows it (realm
/// @nick/craft, node #625).
///
/// # Errors
/// When `cwd` is not in a working tree or `git` fails.
pub fn function_context_diff(cwd: &Path, base: &str) -> Result<String, GitError> {
    not_an_option(cwd, &[base])?;
    diff_with(cwd, "-W", &["--merge-base", base])
}

fn diff_with(cwd: &Path, context: &str, revs: &[&str]) -> Result<String, GitError> {
    let top = toplevel(cwd)?;
    let mut args = vec![
        "-c",
        "core.quotePath=false",
        "diff",
        context,
        "--no-color",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "-M",
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

/// Origin's default branch and the commit where `HEAD` leaves it (`git merge-base`); `None` when
/// origin has no default branch or the two share no history, so nothing can be said of it.
#[must_use]
pub fn trunk_point(cwd: &Path) -> Option<(String, String)> {
    let trunk = default_base(cwd).ok()?;
    let point = git(cwd, &["merge-base", &trunk, "HEAD"]).ok()?;
    Some((trunk, point.trim().to_owned()))
}

/// Whether tracked files in `cwd` differ from `HEAD` (untracked ones aside).
///
/// # Errors
/// When `git` fails.
pub fn dirty(cwd: &Path) -> Result<bool, GitError> {
    let status = git(cwd, &["status", "--porcelain", "--untracked-files=no"])?;
    Ok(!status.trim().is_empty())
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
    let dirty = dirty(cwd)?;
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
    // `-z`: each path as it is, unquoted, so it is spelled as the zero-context diff's headers
    // read it. A path that is not UTF-8 lists the change as git quotes it, as before `-z`; full
    // support is issue #414. `-M`: a renamed file is listed once, at its new path, whatever
    // `diff.renames` says, as the zero-context diff names it.
    let files = match limited(&["diff", "--name-only", "-z", "-M", "--merge-base", &base]) {
        Ok(z) => z
            .split('\0')
            .filter(|f| !f.is_empty())
            .map(str::to_owned)
            .collect(),
        Err(GitError::NotUtf8(_)) => {
            limited(&["diff", "--name-only", "-M", "--merge-base", &base])?
                .lines()
                .map(str::to_owned)
                .collect()
        }
        Err(e) => return Err(e),
    };
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

pub mod warm;

#[cfg(test)]
pub(crate) mod tests;
