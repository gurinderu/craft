//! The checkout a pull request was opened from, read with git at the PR's head: the PR's whole
//! change starts at `git merge-base origin/<base> <head>`, its base ref fetched first when this
//! checkout lacks it.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use craft_review::git;

use super::bounded;
use super::github::Pr;

/// Within the hook's 30 s, beside `gh pr view`'s own limit ([`super::github`]).
const FETCH_LIMIT: Duration = Duration::from_secs(10);

/// The PR as the store keys its runs.
pub struct Here {
    /// The repository as records name it (`repoKey`: the main checkout for a linked worktree).
    pub project: String,
    /// The commit the PR's head is.
    pub head: String,
    /// The branch the PR comes from.
    pub branch: String,
    /// `origin/<base>`, the ref the PR's whole change is measured from.
    pub trunk: String,
    /// `git merge-base <trunk> <head>`: where the PR's whole change starts.
    pub point: String,
}

/// What the judge of a record asks git, apart so its tests need no repository.
pub trait Git {
    /// `git merge-base <base> <head>`, `None` when git cannot say.
    fn merge_base(&self, base: &str) -> Option<String>;
    /// Whether `name` names a commit in this checkout.
    fn has_ref(&self, name: &str) -> bool;
}

/// The checkout in `dir` at the commit `head`.
pub struct Checkout {
    dir: PathBuf,
    head: String,
}

impl Git for Checkout {
    fn merge_base(&self, base: &str) -> Option<String> {
        git::merge_base(&self.dir, base, &self.head).ok()
    }

    fn has_ref(&self, name: &str) -> bool {
        git::has_commit(&self.dir, name)
    }
}

/// The PR `pr` in the checkout `dir`; why not, when git cannot say.
pub fn read(dir: &Path, pr: &Pr) -> Result<(Here, Checkout), String> {
    let at = dir.display();
    git::toplevel(dir).map_err(|e| format!("{at} is not a git checkout ({e})"))?;
    let head = &pr.head_ref_oid;
    if !git::has_commit(dir, head) {
        return Err(format!(
            "the PR's head {} is not in the checkout {at}",
            short(head)
        ));
    }
    let trunk = format!("origin/{}", pr.base_ref_name);
    if !git::has_commit(dir, &trunk) {
        fetch(dir, &pr.base_ref_name)
            .map_err(|why| format!("{trunk} is not in {at} and could not be fetched: {why}"))?;
    }
    let point = git::merge_base(dir, &trunk, head).map_err(|e| {
        format!(
            "git cannot tell where {} leaves {trunk} in {at}: {e}",
            short(head)
        )
    })?;
    let here = Here {
        project: repo_key(dir),
        head: head.clone(),
        branch: pr.head_ref_name.clone(),
        trunk,
        point,
    };
    let checkout = Checkout {
        dir: dir.to_path_buf(),
        head: head.clone(),
    };
    Ok((here, checkout))
}

fn short(sha: &str) -> &str {
    sha.get(..12).unwrap_or(sha)
}

/// The fetch of `origin`'s branch `base` into `origin/<base>`.
fn fetch_command(dir: &Path, base: &str) -> Command {
    let mut cmd = Command::new("git");
    // No maintenance started in the background, for the limit to kill with the group.
    cmd.arg("-C")
        .arg(dir)
        .args(["-c", "maintenance.auto=false", "-c", "gc.auto=0"])
        .args(["fetch", "--quiet", "--no-tags", "origin"])
        .arg(format!("+refs/heads/{base}:refs/remotes/origin/{base}"));
    // As craft's own git runs (realm @nick/craft, node #545): no terminal prompt, no ssh askpass
    // the caller did not choose, a session of its own the limit kills whole ([`bounded`]).
    craft_review::cancel::no_prompt_env(&mut cmd);
    craft_review::cancel::detached(&mut cmd);
    cmd
}

/// `origin`'s branch `base` into `origin/<base>`, bounded and with no prompt for credentials.
fn fetch(dir: &Path, base: &str) -> Result<(), String> {
    let out = bounded::output(fetch_command(dir, base), FETCH_LIMIT)?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    Err(stderr
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("git fetch failed")
        .to_owned())
}

/// The repository as run records name it, `repoKey` in `lib/repo-key.mjs`: the parent of a common
/// git directory named `.git` (a plain checkout and its linked worktrees share it), else the work
/// tree's top level, else the common directory, else the directory itself.
fn repo_key(dir: &Path) -> String {
    key_of(dir, git::common_dir(dir).ok(), || git::toplevel(dir).ok())
}

/// [`repo_key`] from git's answers: `common`, `git rev-parse --git-common-dir` as an absolute
/// path, and `toplevel`, `--show-toplevel`, asked only when needed.
pub fn key_of(
    dir: &Path,
    common: Option<String>,
    toplevel: impl FnOnce() -> Option<PathBuf>,
) -> String {
    let common = common.filter(|c| !c.contains('\n') && Path::new(c).is_absolute());
    if let Some(c) = &common
        && Path::new(c).file_name().is_some_and(|n| n == ".git")
        && let Some(parent) = Path::new(c).parent()
    {
        return parent.display().to_string();
    }
    let found = toplevel().or_else(|| common.map(PathBuf::from));
    found
        .or_else(|| std::fs::canonicalize(dir).ok())
        .unwrap_or_else(|| dir.to_path_buf())
        .display()
        .to_string()
}

#[cfg(test)]
#[path = "repo_tests.rs"]
mod tests;
