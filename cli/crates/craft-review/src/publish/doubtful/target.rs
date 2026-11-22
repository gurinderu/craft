//! Where a doubtful finding goes: the pull request of the record's own branch, and the reviewed
//! commit the record names.

use std::path::Path;

use super::super::gh::read::{self, Pr};
use super::super::short;
use super::{Doubtful, PostError, request};
use crate::gate::runner::Runner;

/// Why nothing is posted for a record naming no reviewed commit: the PR's head cannot be told to
/// hold the finding's line.
pub(super) const NO_REVIEWED: &str = "the record names no reviewed commit, so whether the PR's head still holds the finding's line cannot be told: nothing posted — review the PR's head again";

/// The record's reviewed head, when it is a full commit sha.
pub(super) fn full<'a>(d: &Doubtful<'a>) -> Option<&'a str> {
    d.reviewed
        .filter(|h| matches!(h.len(), 40 | 64) && request::is_sha(h))
}

/// The pull request of the record's own branch (realm @nick/craft, node #270: the PR is never
/// guessed by the branch checked out now): `pr` when its head branch is the record's, or the
/// reviewed head is on its history; without `pr`, the one open PR whose head is the record's
/// branch.
pub(super) fn which_pr(
    runner: &Runner,
    repo: &Path,
    d: &Doubtful<'_>,
    pr: Option<u64>,
) -> Result<Pr, PostError> {
    let branch = d.branch.filter(|b| !b.is_empty());
    let Some(n) = pr else {
        let b = branch.ok_or_else(|| {
            PostError::Pr(
                "the record names no branch (a review on a detached HEAD): name the PR with --pr"
                    .into(),
            )
        })?;
        let mut prs = read::open_prs(runner, repo, b).map_err(PostError::Pr)?;
        return match prs.len() {
            1 => Ok(prs.remove(0)),
            0 => Err(PostError::Pr(format!(
                "no open PR has the record's branch {b} as its head: name it with --pr"
            ))),
            k => Err(PostError::Pr(format!(
                "{k} open PRs have the record's branch {b} as their head: name one with --pr"
            ))),
        };
    };
    let p = read::pull_request(runner, repo, Some(&n.to_string())).map_err(PostError::Pr)?;
    let held = full(d).is_some_and(|h| crate::git::holds(repo, &p.head, h));
    if branch == Some(p.head_ref.as_str()) || held {
        return Ok(p);
    }
    Err(PostError::Pr(format!(
        "PR #{n} has head branch {}, not the record's {}, and its head {} does not hold the reviewed commit: name the PR of the reviewed branch",
        p.head_ref,
        branch.unwrap_or("(none)"),
        short(&p.head)
    )))
}
