//! Whether the PR the record names takes the comment now, and on which commit: the PR open, its
//! head holding the reviewed commit (fetched from `origin`'s `pull/<n>/head` when this repository
//! lacks it, bounded and never prompting), and the reviewed commit itself when the head moved past
//! it without touching the finding's line.

use std::path::Path;

use super::super::after::moved_over;
use super::super::gh::{Moved, read::Pr};
use super::super::{short, sort};
use super::PostError;
use super::request::Chosen;
use crate::cancel::Cancel;

/// Refuses a PR that is not open, or whose head does not hold `reviewed`.
pub(super) fn postable(repo: &Path, p: &Pr, reviewed: &str) -> Result<(), PostError> {
    if p.state != "OPEN" {
        let state = if p.state.is_empty() {
            "of no state gh named"
        } else {
            &p.state
        };
        return Err(PostError::Pr(format!(
            "PR #{} is {state}, not open: a doubtful finding is posted only on an open PR",
            p.number
        )));
    }
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
