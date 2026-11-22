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

/// The pull request the record's review read (realm @nick/craft, node #270: the PR is never
/// guessed by the branch checked out now), its head holding the reviewed commit `reviewed`: the PR
/// the run published on (`prComments.pr`, the PR a detached `pr=<n>` review was started with),
/// same-repository; else, for a record of a branch, `pr` when its head branch is the record's, or
/// without `pr` the one open same-repository PR whose head is that branch — a fork's PR of a
/// branch of the same name is not this record's; else, for a record of a detached HEAD, `pr` when
/// it is same-repository.
pub(super) fn which_pr(
    runner: &Runner,
    repo: &Path,
    (d, reviewed): (&Doubtful<'_>, &str),
    pr: Option<u64>,
) -> Result<Pr, PostError> {
    let p = chosen(runner, repo, d, pr)?;
    if !holds(repo, &p, reviewed) {
        return Err(PostError::Pr(format!(
            "PR #{}'s head {} does not hold the reviewed commit {} (fetched from origin when missing): it is not the PR the review read",
            p.number,
            short(&p.head),
            short(reviewed)
        )));
    }
    Ok(p)
}

/// The one open same-repository PR whose head branch is `branch`.
fn only_pr(runner: &Runner, repo: &Path, branch: &str) -> Result<Pr, PostError> {
    let mut prs = read::open_prs(runner, repo, branch).map_err(PostError::Pr)?;
    prs.retain(|p| !p.cross_repository);
    match prs.len() {
        1 => Ok(prs.remove(0)),
        0 => Err(PostError::Pr(format!(
            "no open PR of this repository has the record's branch {branch} as its head: name it with --pr"
        ))),
        k => Err(PostError::Pr(format!(
            "{k} open PRs of this repository have the record's branch {branch} as their head: name one with --pr"
        ))),
    }
}

/// Whether the PR's head holds `reviewed`, the head fetched from `origin`'s `pull/<n>/head` first
/// when this repository lacks it.
fn holds(repo: &Path, p: &Pr, reviewed: &str) -> bool {
    if !crate::git::has_commit(repo, &p.head) {
        let refspec = format!("pull/{}/head", p.number);
        drop(crate::git::git(
            repo,
            &[
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                "--quiet",
                "origin",
                &refspec,
            ],
        ));
    }
    crate::git::holds(repo, &p.head, reviewed)
}

/// The PR [`which_pr`] takes, before its head is checked.
fn chosen(
    runner: &Runner,
    repo: &Path,
    d: &Doubtful<'_>,
    pr: Option<u64>,
) -> Result<Pr, PostError> {
    let branch = d.branch.filter(|b| !b.is_empty() && *b != "HEAD");
    match (d.record_pr, pr, branch) {
        (Some(rp), Some(n), _) if rp != n => Err(PostError::Pr(format!(
            "PR #{n} is not PR #{rp}, the one the review published on: drop --pr or name #{rp}"
        ))),
        (None, None, Some(b)) => only_pr(runner, repo, b),
        (None, Some(n), Some(b)) => {
            let p = view(runner, repo, n)?;
            if p.head_ref == b {
                Ok(p)
            } else {
                Err(PostError::Pr(format!(
                    "PR #{n} has head branch {}, not the record's {b}: name the PR of the reviewed branch",
                    p.head_ref
                )))
            }
        }
        (Some(n), _, _) | (None, Some(n), None) => same_repo(view(runner, repo, n)?),
        (None, None, None) => Err(PostError::Pr(
            "the record names no branch and no PR (a review on a detached HEAD that published nothing): name the PR it reviewed with --pr".into(),
        )),
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
