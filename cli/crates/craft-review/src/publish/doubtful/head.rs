//! Whether the PR the record names holds the finding's comment already, whether it takes the
//! comment now, and on which commit: the PR open, its
//! head holding the reviewed commit (fetched from `origin`'s `pull/<n>/head` when this repository
//! lacks it, bounded and never prompting), and the reviewed commit itself when the head moved past
//! it without touching the finding's line.

use std::path::Path;

use super::super::after::moved_over;
use super::super::gh::{Moved, read, read::Pr};
use super::super::{body, short, sort};
use super::request::Chosen;
use super::{PostError, Posting};
use crate::cancel::Cancel;
use crate::gate::runner::Runner;

/// Whether the finding's comment is on `p` already: on its line, or on its file (where GitHub put
/// it when it refused the line).
pub(super) fn already(
    runner: &Runner,
    repo: &Path,
    p: &Pr,
    c: &Chosen<'_>,
) -> Result<bool, PostError> {
    let seen = read::posted_already(runner, repo, p.number).map_err(|e| {
        PostError::Gh(format!(
            "{e} — nothing posted, since what is there already could not be read"
        ))
    })?;
    let first = body::first_line(&c.body).to_owned();
    let on_line = (c.file.clone(), c.line.map_or(0, u64::from), first.clone());
    Ok(seen.contains(&(c.file.clone(), 0, first)) || seen.contains(&on_line))
}

/// A retry's earlier comment on a closed same-repository PR of the record's branch, when none is
/// open: each PR's head checked to hold the reviewed commit first (a fetch that fails is named);
/// a PR whose comments cannot be read is passed over and named, since the comment may sit there.
pub(super) fn on_closed(
    runner: &Runner,
    repo: &Path,
    (prs, why): (&[Pr], &str),
    c: &Chosen<'_>,
    reviewed: &str,
) -> Result<Posting, PostError> {
    let mut unread = Vec::new();
    for p in prs {
        match holding(repo, p, reviewed) {
            Err(e @ PostError::Fetch(_)) => return Err(e),
            Err(_) => continue,
            Ok(()) => {}
        }
        match already(runner, repo, p, c) {
            Ok(true) => return Ok(Posting::already(p, reviewed)),
            Ok(false) => {}
            Err(e) => unread.push(format!("PR #{}: {e}", p.number)),
        }
    }
    if unread.is_empty() {
        return Err(PostError::Pr(why.to_owned()));
    }
    Err(PostError::Gh(format!(
        "{why}; the comments of the closed PR(s) of the branch, where an earlier post may sit, could not all be read — {}",
        unread.join("; ")
    )))
}

/// Refuses a PR that is not open.
pub(super) fn open(p: &Pr) -> Result<(), PostError> {
    if p.state == "OPEN" {
        return Ok(());
    }
    let state = if p.state.is_empty() {
        "of no state gh named"
    } else {
        &p.state
    };
    Err(PostError::Pr(format!(
        "PR #{} is {state}, not open: a doubtful finding is posted only on an open PR",
        p.number
    )))
}

/// Refuses a PR whose head does not hold `reviewed`, the head fetched from `origin` first when
/// this repository lacks it.
pub(super) fn holding(repo: &Path, p: &Pr, reviewed: &str) -> Result<(), PostError> {
    crate::rereview::branch::fetch_pr_head(repo, p.number, &p.head, &Cancel::default()).map_err(
        |e| {
            PostError::Fetch(format!(
                "PR #{}'s head {} is not in this repository and fetching it from origin failed: {e} — nothing posted",
                p.number,
                short(&p.head)
            ))
        },
    )?;
    if crate::git::holds(repo, &p.head, reviewed) {
        return Ok(());
    }
    Err(PostError::Pr(format!(
        "PR #{}'s head {} does not hold the reviewed commit {}: it is not the PR the review read",
        p.number,
        short(&p.head),
        short(reviewed)
    )))
}

/// The commit the comment goes on — the reviewed one — and the note saying how the PR's head
/// moved past it; refused when the head's new commits touch the finding's line.
pub(super) fn commit_for(
    repo: &Path,
    c: &Chosen<'_>,
    reviewed: &str,
    p: &Pr,
) -> Result<String, PostError> {
    if reviewed == p.head {
        return Ok(String::new());
    }
    let line = sort::line(c.finding);
    let title = sort::text(c.finding, "title");
    let touched = |old: &crate::gate::lines::Lines| {
        (line > 0 && old.touches(&c.file, line))
            .then(|| format!("`{}:{line}` {title}", c.file))
            .into_iter()
            .collect()
    };
    match moved_over(repo, reviewed, &p.head, &touched) {
        Moved::Post(note) => Ok(format!(" · {note}")),
        Moved::Refuse(why) | Moved::Skip(why) => Err(PostError::Refused(why)),
    }
}
