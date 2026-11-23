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

/// The PR the record's review read, and how far it is trusted before its comments are read.
pub(super) enum Found {
    /// The record's own: the PR it published on, or the one open PR of its branch — a comment of
    /// the finding on it is the record's, so a retry finds it first.
    Own(Pr),
    /// Named with `--pr`: its head must hold the reviewed commit before a comment on it counts.
    Named(Pr),
    /// No open PR of the record's branch: its closed same-repository ones, on which an earlier
    /// post may sit, and why nothing can be posted otherwise.
    Closed(Vec<Pr>, String),
}

/// The pull request the record's review read (realm @nick/craft, node #270: the PR is never
/// guessed by the branch checked out now), same-repository: the PR the run published on
/// (`prComments.pr`, the PR a detached `pr=<n>` review was started with); else, for a record of a
/// branch, `pr` when its head branch is the record's, or without `pr` the one open PR whose head is
/// that branch — a fork's PR of a branch of the same name is not this record's; else, for a record
/// of a detached HEAD, `pr`. Whether it is open and its head holds the reviewed commit is
/// [`super::head`]'s to judge.
pub(super) fn which_pr(
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
        (Some(n), _, _) => Ok(Found::Own(same_repo(view(runner, repo, n)?)?)),
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
        (None, Some(n), None) => Ok(Found::Named(same_repo(view(runner, repo, n)?)?)),
        (None, None, None) => Err(PostError::Pr(
            "the record names no branch and no PR (a review on a detached HEAD that published nothing): name the PR it reviewed with --pr".into(),
        )),
    }
}

/// The one open same-repository PR whose head branch is `branch`; with none, its closed ones.
fn only_pr(runner: &Runner, repo: &Path, branch: &str) -> Result<Found, PostError> {
    let ours = |state| -> Result<Vec<Pr>, PostError> {
        let mut prs = read::prs(runner, repo, branch, state).map_err(PostError::Pr)?;
        prs.retain(|p| !p.cross_repository);
        Ok(prs)
    };
    let mut prs = ours("open")?;
    match prs.len() {
        1 => Ok(Found::Own(prs.remove(0))),
        0 => {
            let mut closed = ours("all")?;
            closed.retain(|p| p.state != "OPEN");
            Ok(Found::Closed(
                closed,
                format!(
                    "no open PR of this repository has the record's branch {branch} as its head: name it with --pr"
                ),
            ))
        }
        k => Err(PostError::Pr(format!(
            "{k} open PRs of this repository have the record's branch {branch} as their head: name one with --pr"
        ))),
    }
}

fn view(runner: &Runner, repo: &Path, n: u64) -> Result<Pr, PostError> {
    read::pull_request(runner, repo, Some(&n.to_string())).map_err(PostError::Pr)
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
