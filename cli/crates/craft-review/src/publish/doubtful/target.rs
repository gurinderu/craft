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
/// guessed by the branch checked out now) whose head holds the reviewed commit `reviewed`: `pr`
/// when its head branch is the record's; without `pr`, the one open same-repository PR whose head
/// is the record's branch — a fork's PR of a branch of the same name is not this record's.
pub(super) fn which_pr(
    runner: &Runner,
    repo: &Path,
    (d, reviewed): (&Doubtful<'_>, &str),
    pr: Option<u64>,
) -> Result<Pr, PostError> {
    let branch = d.branch.filter(|b| !b.is_empty()).ok_or_else(|| {
        PostError::Pr("the record names no branch (a review on a detached HEAD), so no PR can be told to be its own: nothing posted".into())
    })?;
    let p = match pr {
        None => only_pr(runner, repo, branch)?,
        Some(n) => {
            let p =
                read::pull_request(runner, repo, Some(&n.to_string())).map_err(PostError::Pr)?;
            if p.head_ref != branch {
                return Err(PostError::Pr(format!(
                    "PR #{n} has head branch {}, not the record's {branch}: name the PR of the reviewed branch",
                    p.head_ref
                )));
            }
            p
        }
    };
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
