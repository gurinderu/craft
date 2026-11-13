//! Where a review of the pull request given (`pr=`) runs when this checkout's `HEAD` does not hold
//! its head: craft's own detached worktree, `<worktrees>/<repo key>/pr-<N>`, outside the user's
//! repository and registered with it, the head fetched from `origin` when the repository lacks it
//! (realm `@nick/craft`, node #517). A worktree there from before is moved to the head when clean
//! and refused when dirty; the user's checkout and every other worktree are never touched. Where
//! the head cannot be got, the run is refused with the manual way ([`super::head`]).

use std::path::{Path, PathBuf};

use super::head::{self, short};
use super::{BUDGET, Lookup, pr};
use crate::gate::runner::Runner;
use crate::git;
use crate::project::project_id;
use crate::sources::Git;

/// The worktree the review runs in, and the one line saying so for the report and the answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Laid {
    pub dir: PathBuf,
    pub line: String,
}

/// The worktree `cwd`'s review of the PR given runs in, laid or moved under `root`: `None` when no
/// PR is given, gh is not asked or cannot tell (the chain notes it, [`super::resolve`]), there is
/// no `root`, or `HEAD` already holds the PR's head.
///
/// # Errors
/// The refusal, when the head cannot be fetched, the worktree cannot be laid or moved, or the
/// place holds a dirty worktree or something that is no worktree of this repository.
pub fn checkout(
    cwd: &Path,
    lookup: &Lookup<'_>,
    root: Option<&Path>,
) -> Result<Option<Laid>, String> {
    let (Some(n), Some(setup), Some(root)) = (lookup.pr, lookup.gh, root) else {
        return Ok(None);
    };
    let Ok(head) = git::git(cwd, &["rev-parse", "HEAD"]) else {
        return Ok(None);
    };
    let head = head.trim();
    let runner = Runner::new(
        setup.budget.min(BUDGET),
        setup.path.clone(),
        lookup.dir.clone(),
    );
    let pr_head = match pr::given(&runner, cwd, n) {
        Ok(named) if !named.head.is_empty() => named.head,
        Ok(_) | Err(_) => return Ok(None),
    };
    if git::holds(cwd, head, &pr_head) {
        return Ok(None);
    }
    let refuse = |why: String| head::refusal(n, &pr_head, head, Some(&why));
    let dir = place(cwd, root, n).map_err(refuse)?;
    fetch(cwd, n, &pr_head).map_err(refuse)?;
    let how = if dir.exists() {
        mine(cwd, &dir).map_err(refuse)?;
        move_to(&dir, n, &pr_head)?;
        "moved there"
    } else {
        add(cwd, &dir, &pr_head).map_err(refuse)?;
        "laid now"
    };
    let dir = dir.canonicalize().map_err(|e| refuse(e.to_string()))?;
    let line = format!(
        "pr={n}: this checkout's HEAD `{}` does not hold PR #{n}'s head `{}`, so craft reviewed it in its own detached worktree {} ({how}); your checkout was not touched",
        short(head),
        short(&pr_head),
        dir.display()
    );
    Ok(Some(Laid { dir, line }))
}

/// `<root>/<repo key>/pr-<n>`, the key the repository's profile is kept under.
fn place(cwd: &Path, root: &Path, n: u64) -> Result<PathBuf, String> {
    let common = git::common_dir(cwd).map_err(|e| e.to_string())?;
    Ok(root.join(project_id(&common)).join(format!("pr-{n}")))
}

/// PR `n`'s head `pr_head` in this repository: fetched from `origin`'s `pull/<n>/head` when it
/// lacks it, never prompting.
fn fetch(cwd: &Path, n: u64, pr_head: &str) -> Result<(), String> {
    if git::has_commit(cwd, pr_head) {
        return Ok(());
    }
    let refspec = format!("pull/{n}/head");
    let at = cwd.display().to_string();
    Git::prompt_free().run(&[
        "-C",
        &at,
        "fetch",
        "--no-tags",
        "--quiet",
        "origin",
        &refspec,
    ])?;
    if git::has_commit(cwd, pr_head) {
        Ok(())
    } else {
        Err(format!(
            "origin's `{refspec}` does not hold `{}`",
            short(pr_head)
        ))
    }
}

/// Whether `dir` is the top of a worktree of the repository `cwd` is in.
fn mine(cwd: &Path, dir: &Path) -> Result<(), String> {
    let stranger = |why: &dyn std::fmt::Display| {
        format!(
            "{} is there but is not a worktree of this repository: {why}",
            dir.display()
        )
    };
    let common = git::common_dir(cwd).map_err(|e| e.to_string())?;
    let theirs = git::common_dir(dir).map_err(|e| stranger(&e))?;
    let top = git::toplevel(dir).map_err(|e| stranger(&e))?;
    let same = |a: &Path, b: &Path| a.canonicalize().ok() == b.canonicalize().ok();
    if same(Path::new(&common), Path::new(&theirs)) && same(&top, dir) {
        Ok(())
    } else {
        Err(stranger(&"its git directory or top level is another"))
    }
}

/// Craft's worktree `dir` moved to PR `n`'s head, refused when its tracked files have changes.
fn move_to(dir: &Path, n: u64, pr_head: &str) -> Result<(), String> {
    if git::dirty(dir).unwrap_or(true) {
        return Err(format!(
            "pr={n}: craft's worktree for PR #{n}, {}, has local changes, so it was not moved to the PR's head `{}`. Commit or discard them there — or remove it with `git worktree remove {}` — and run again. Nothing was reviewed and no round was filed.",
            dir.display(),
            short(pr_head),
            dir.display()
        ));
    }
    git::git(dir, &["checkout", "--quiet", "--detach", pr_head])
        .map(drop)
        .map_err(|e| format!("pr={n}: moving craft's worktree {} to PR #{n}'s head failed: {e}. Nothing was reviewed and no round was filed.", dir.display()))
}

/// A detached worktree of `cwd`'s repository at `dir`, on `pr_head`.
fn add(cwd: &Path, dir: &Path, pr_head: &str) -> Result<(), String> {
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let at = dir.display().to_string();
    git::git(
        cwd,
        &["worktree", "add", "--quiet", "--detach", &at, pr_head],
    )
    .map(drop)
    .map_err(|e| e.to_string())
}
