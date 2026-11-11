//! Whether `HEAD` is the head of the pull request given (`pr=`), which names the PR whose head is
//! `HEAD` and never checks it out: a run from another commit — the trunk, a stale checkout — would
//! review that commit and chain its rounds onto the PR. It is refused before any task, saying how
//! to review the PR's head. A `HEAD` ahead of it, with commits not yet pushed, is refused as well:
//! publishing refuses a reviewed head the PR's head does not hold ([`crate::publish`]), so its
//! findings could not be posted, and its rounds would chain onto a PR that does not hold them.

use std::path::Path;

use crate::git;

/// Why the run is refused: `HEAD` (`head`) is not PR `n`'s head `pr_head`.
pub(super) fn mismatch(cwd: &Path, n: u64, pr_head: &str, head: &str) -> String {
    let named = format!(
        "pr={n} names PR #{n}, whose head is `{}`, but this checkout's HEAD is `{}`",
        short(pr_head),
        short(head)
    );
    let drop = "or drop `pr=` to review this checkout as it is. Nothing was reviewed and no round was filed.";
    match ahead_by(cwd, pr_head) {
        Some(k) => format!(
            "{named}: HEAD is {k} commit{} ahead of the PR's head, not yet pushed. Push first, so the PR's head is HEAD, and run again; {drop}",
            if k == 1 { "" } else { "s" }
        ),
        None => format!(
            "{named}, so the review would read another commit than the PR's. Check the PR's head out in a worktree and run there — `gh pr checkout {n}`, or `git worktree add --detach <dir> {pr_head}` — {drop}"
        ),
    }
}

/// How many commits `HEAD` has beyond `pr_head`, when `pr_head` is an ancestor of it.
fn ahead_by(cwd: &Path, pr_head: &str) -> Option<u64> {
    if !git::is_ancestor(cwd, pr_head) {
        return None;
    }
    let range = format!("{pr_head}..HEAD");
    let count = git::git(cwd, &["rev-list", "--count", &range]).ok()?;
    count.trim().parse().ok()
}

fn short(sha: &str) -> &str {
    sha.get(..12).unwrap_or(sha)
}
