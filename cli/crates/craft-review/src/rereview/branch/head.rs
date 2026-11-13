//! Whether `HEAD` holds the head of the pull request given (`pr=`), which names the PR whose head
//! is `HEAD` and never checks it out: a run from a commit off the PR's history — the trunk, a stale
//! checkout — would review that commit and chain its rounds onto the PR. craft then reviews the
//! head in its own worktree ([`super::worktree`]); where it cannot get it there, the run is refused
//! before any task, saying how to review the PR's head (realm `@nick/craft`, node #517). A `HEAD`
//! ahead of it, with fix commits not yet pushed, is reviewed — review comes before the push (realm
//! @nick/craft, node #127) — and noted: its findings post only once the PR's head holds the
//! reviewed head ([`crate::publish`]).

use std::path::Path;

use crate::git;

/// `None` when `HEAD` (`head`) is PR `n`'s head `pr_head`, the note when it is ahead of it.
///
/// # Errors
/// The refusal when `HEAD` does not hold `pr_head`, or this repository lacks it to tell.
pub(super) fn check(
    cwd: &Path,
    n: u64,
    pr_head: &str,
    head: &str,
) -> Result<Option<String>, String> {
    if pr_head == head {
        return Ok(None);
    }
    let Some(k) = ahead_by(cwd, pr_head) else {
        return Err(refusal(n, pr_head, head, None));
    };
    Ok(Some(format!(
        "HEAD is {k} commit{} ahead of PR #{n}'s head `{}`; push before publishing — findings post only once the PR's head holds the reviewed head",
        if k == 1 { "" } else { "s" },
        short(pr_head)
    )))
}

/// Why the run is refused: `HEAD` does not hold PR `n`'s head `pr_head`, and craft could not lay
/// its own worktree for it (`why`), or was not asked to.
pub(super) fn refusal(n: u64, pr_head: &str, head: &str, why: Option<&str>) -> String {
    let laid = why.map_or_else(String::new, |why| {
        format!(" craft could not lay its own worktree for it ({why}).")
    });
    format!(
        "pr={n} names PR #{n}, whose head is `{}`, but this checkout's HEAD is `{}` and does not hold it, so the review would read another commit than the PR's.{laid} Check the PR's head out in a detached worktree of your own and run there — `git fetch origin pull/{n}/head && git worktree add --detach ~/.craft/worktrees/<repo>/pr-{n}-{} FETCH_HEAD`, never a worktree another session made, or `gh pr checkout {n}` in a worktree — or drop `pr=` to review this checkout as it is. Nothing was reviewed and no round was filed.",
        short(pr_head),
        short(head),
        short(pr_head)
    )
}

/// How many commits `HEAD` has beyond `pr_head`, when this repository has `pr_head` and it is an
/// ancestor of `HEAD`.
fn ahead_by(cwd: &Path, pr_head: &str) -> Option<u64> {
    if !git::is_ancestor(cwd, pr_head) {
        return None;
    }
    let range = format!("{pr_head}..HEAD");
    let count = git::git(cwd, &["rev-list", "--count", &range]).ok()?;
    count.trim().parse().ok()
}

pub(super) fn short(sha: &str) -> &str {
    sha.get(..12).unwrap_or(sha)
}
