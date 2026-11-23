//! Where a doubtful finding goes: the pull request of the record's own branch, and the reviewed
//! commit the record names.

use std::path::Path;

use super::super::gh::read::{self, Pr};
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

/// The tail of the refusal when no `--pr` is given, no PR is recorded for the finding, and none of
/// the record's branch is open: closed PRs are never searched.
pub(super) const NAME_IT: &str = "the PR is closed or gone: name it with --pr <n>";

/// The PR the record's review read, and how far it is trusted before its comments are read.
pub(super) enum Found {
    /// A PR this record already recorded — the one its finding's post chose (the posting mark), or
    /// the one the run published on — or the one open PR of its branch: a comment of the finding
    /// on it is the record's, so it is read before the PR's state and head are judged.
    Own(Pr),
    /// Named with `--pr`, another than any the record recorded: its head must hold the reviewed
    /// commit before a comment on it counts.
    Named(Pr),
}

/// The pull request the record's review read (realm @nick/craft, node #270: the PR is never
/// guessed by the branch checked out now), same-repository: the PR the run published on
/// (`prComments.pr`, the PR a detached `pr=<n>` review was started with); else, for a record of a
/// branch, `pr` when its head branch is the record's, or without `pr` the one open PR whose head is
/// that branch — a fork's PR of a branch of the same name is not this record's; else, for a record
/// of a detached HEAD, `pr`. Before all of them, with no `pr`, the PR the finding's earlier post
/// recorded, whatever its state. Its head and state are [`super::head`]'s to judge.
pub(super) fn which_pr(
    runner: &Runner,
    repo: &Path,
    d: &Doubtful<'_>,
    pr: Option<u64>,
) -> Result<Found, PostError> {
    if let (Some(r), None) = (d.posted_on, pr) {
        return Ok(Found::Own(same_repo(view(runner, repo, r)?)?));
    }
    let found = chosen(runner, repo, d, pr)?;
    Ok(match found {
        Found::Named(p) if [d.posted_on, d.record_pr].contains(&Some(p.number)) => Found::Own(p),
        other @ (Found::Own(_) | Found::Named(_)) => other,
    })
}

/// The PR [`which_pr`] takes when the finding's post recorded none, or `pr` names one.
fn chosen(
    runner: &Runner,
    repo: &Path,
    d: &Doubtful<'_>,
    pr: Option<u64>,
) -> Result<Found, PostError> {
    let branch = d.branch.filter(|b| !b.is_empty() && *b != "HEAD");
    match (d.record_pr, pr, branch) {
        (Some(rp), Some(n), _) if rp != n => Err(PostError::Pr(format!(
            "PR #{n} is not PR #{rp}, the one the review published on: drop --pr or name #{rp}"
        ))),
        (Some(n), None, _) => Ok(Found::Own(same_repo(view(runner, repo, n)?)?)),
        (None, None, Some(b)) => only_pr(runner, repo, b),
        (None, Some(n), Some(b)) => {
            let p = view(runner, repo, n)?;
            if p.head_ref == b {
                Ok(Found::Named(same_repo(p)?))
            } else {
                Err(PostError::Pr(format!(
                    "PR #{n} has head branch {}, not the record's {b}: name the PR of the reviewed branch",
                    p.head_ref
                )))
            }
        }
        (Some(n), Some(_), _) | (None, Some(n), None) => {
            Ok(Found::Named(same_repo(view(runner, repo, n)?)?))
        }
        (None, None, None) => Err(PostError::Pr(
            "the record names no branch and no PR (a review on a detached HEAD that published nothing): name the PR it reviewed with --pr".into(),
        )),
    }
}

/// The one open same-repository PR whose head branch is `branch`. A list gh could not give is a
/// failure on the way (a retry may get it), not a refusal.
fn only_pr(runner: &Runner, repo: &Path, branch: &str) -> Result<Found, PostError> {
    let mut prs = read::prs(runner, repo, branch, "open").map_err(|e| {
        if branch.starts_with('-') {
            PostError::Pr(e)
        } else {
            PostError::Gh(e)
        }
    })?;
    prs.retain(|p| !p.cross_repository);
    match prs.len() {
        1 => Ok(Found::Own(prs.remove(0))),
        0 => Err(PostError::Pr(format!(
            "no open PR of this repository has the record's branch {branch} as its head — {NAME_IT}"
        ))),
        k => Err(PostError::Pr(format!(
            "{k} open PRs of this repository have the record's branch {branch} as their head: name one with --pr"
        ))),
    }
}

/// PR `n` as gh names it: a PR gh says does not exist is refused; any other failure (a 5xx, a
/// timeout, no gh) is a failure on the way, which a retry may get past.
fn view(runner: &Runner, repo: &Path, n: u64) -> Result<Pr, PostError> {
    read::pull_request(runner, repo, Some(&n.to_string())).map_err(|e| {
        if e.contains("Could not resolve to a PullRequest") || e.contains("no pull requests found")
        {
            PostError::Pr(format!("PR #{n}: {e}"))
        } else {
            PostError::Gh(format!("PR #{n}: {e}"))
        }
    })
}

/// `p`, refused when its head is a fork's.
fn same_repo(p: Pr) -> Result<Pr, PostError> {
    if p.cross_repository {
        return Err(PostError::Pr(format!(
            "PR #{} comes from a fork: a doubtful finding is posted only on a PR of this repository",
            p.number
        )));
    }
    Ok(p)
}
