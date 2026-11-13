//! Where a review of the pull request given (`pr=`) runs when this checkout's `HEAD` does not hold
//! its head: craft's own detached worktree, `<worktrees>/<repo key>/pr-<N>-<head>`, outside the
//! user's checkout and registered with its repository, the head fetched from `origin` when the
//! repository lacks it (realm `@nick/craft`, node #517). Keyed on the head, one there from before
//! is reused, never moved — runs on several hosts at once share it, laying it one at a time
//! ([`lock`]); a dirty one, one at another `HEAD` or a stranger is refused. The user's checkout and
//! every other worktree are never touched; the repository's `.git` gains the fetched objects and
//! the worktree's metadata. Where the head cannot be got, the run is refused with the manual way.

use std::path::{Path, PathBuf};

use super::head::{self, short};
use super::{BUDGET, Lookup, pr};
use crate::gate::runner::Runner;
use crate::git;
use crate::project::project_id;
use crate::sources::Git;

mod lock;

/// The worktree the review runs in, and the one line saying so for the report and the answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Laid {
    pub dir: PathBuf,
    pub line: String,
}

/// The worktree `cwd`'s review of the PR given runs in, laid or reused under `root`: `None` when no
/// PR is given, gh is not asked or cannot tell (the chain notes it, [`super::resolve`]), there is
/// no `root`, or `HEAD` already holds the PR's head. Its line says how the task agents read it
/// only when the Claude Code plugin's review engine drives the run (`engine`): `craft review run`
/// runs its tasks in the worktree itself.
///
/// # Errors
/// The refusal, when the head cannot be fetched, the worktree cannot be laid, or the place holds a
/// dirty worktree, one at another `HEAD` or something that is no worktree of this repository.
pub fn checkout(
    cwd: &Path,
    lookup: &Lookup<'_>,
    root: Option<&Path>,
    engine: bool,
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
    let dir = place(cwd, root, n, &pr_head).map_err(refuse)?;
    let _held = lock::Lock::take(&dir).map_err(refuse)?;
    let how = if dir.exists() {
        reuse(cwd, &dir, &pr_head).map_err(refuse)?;
        clean(&dir, n)?;
        "reused at that head"
    } else {
        fetch(cwd, n, &pr_head).map_err(refuse)?;
        add(cwd, &dir, &pr_head).map_err(refuse)?;
        "laid now"
    };
    let dir = dir.canonicalize().map_err(|e| refuse(e.to_string()))?;
    let mut line = format!(
        "pr={n}: this checkout's HEAD `{}` does not hold PR #{n}'s head `{}`, so craft reviewed it in its own detached worktree {} ({how}); your checkout was not touched",
        short(head),
        short(&pr_head),
        dir.display()
    );
    if engine {
        line.push_str(". Driven by the Claude Code plugin's review engine, the task agents run in the session's directory and read this worktree by its absolute path (not yet observed live)");
    }
    Ok(Some(Laid { dir, line }))
}

/// `<root>/<repo key>/pr-<n>-<head>`, keyed on the repository as its profile is and on the head,
/// so runs on one head share it and a run on another never moves it.
fn place(cwd: &Path, root: &Path, n: u64, pr_head: &str) -> Result<PathBuf, String> {
    let common = git::common_dir(cwd).map_err(|e| e.to_string())?;
    let name = format!("pr-{n}-{}", short(pr_head));
    Ok(root.join(project_id(&common)).join(name))
}

const FETCH: [&str; 4] = ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet"];

/// PR `n`'s head `pr_head` in this repository: fetched from `origin`'s `pull/<n>/head` when it
/// lacks it, never prompting, and leaving the user's `FETCH_HEAD` as it was.
fn fetch(cwd: &Path, n: u64, pr_head: &str) -> Result<(), String> {
    if git::has_commit(cwd, pr_head) {
        return Ok(());
    }
    let refspec = format!("pull/{n}/head");
    let at = cwd.display().to_string();
    Git::prompt_free().run(&[&["-C", at.as_str()][..], &FETCH, &["origin", &refspec]].concat())?;
    let missing = || format!("origin's `{refspec}` does not hold `{}`", short(pr_head));
    git::has_commit(cwd, pr_head)
        .then_some(())
        .ok_or_else(missing)
}

const STRANGER: &str = "is not a worktree of this repository";

/// Whether `dir` is the top of a worktree of the repository `cwd` is in, its `HEAD` at `pr_head`.
fn reuse(cwd: &Path, dir: &Path, pr_head: &str) -> Result<(), String> {
    let other = |why: &dyn std::fmt::Display| format!("{} is there but {why}", dir.display());
    let common = git::common_dir(cwd).map_err(|e| e.to_string())?;
    let stranger = |e: git::GitError| other(&format_args!("{STRANGER} ({e})"));
    let theirs = git::common_dir(dir).map_err(stranger)?;
    let top = git::toplevel(dir).map_err(stranger)?;
    let same = |a: &Path, b: &Path| a.canonicalize().ok() == b.canonicalize().ok();
    if !(same(Path::new(&common), Path::new(&theirs)) && same(&top, dir)) {
        return Err(other(&STRANGER));
    }
    let at = git::git(dir, &["rev-parse", "HEAD"]).map_err(|e| other(&e))?;
    if at.trim() == pr_head {
        Ok(())
    } else {
        Err(other(&format_args!(
            "its HEAD is `{}`, not the PR's head",
            short(at.trim())
        )))
    }
}

/// Whether craft's worktree `dir` for PR `n` has no change to its tracked files, else untouched.
fn clean(dir: &Path, n: u64) -> Result<(), String> {
    if !git::dirty(dir).unwrap_or(true) {
        return Ok(());
    }
    Err(format!(
        "pr={n}: craft's worktree for PR #{n}'s head, {}, has local changes, so it is not reviewed as that head. Commit or discard them there — or remove it with `git worktree remove {}` — and run again. Nothing was reviewed and no round was filed.",
        dir.display(),
        dir.display()
    ))
}

/// A detached worktree of `cwd`'s repository at `dir`, on `pr_head`; its parent made by [`lock`].
fn add(cwd: &Path, dir: &Path, pr_head: &str) -> Result<(), String> {
    let at = dir.display().to_string();
    let args = ["worktree", "add", "--quiet", "--detach", &at, pr_head];
    git::git(cwd, &args).map(drop).map_err(|e| e.to_string())
}
