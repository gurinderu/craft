//! Posting one doubtful finding the reviewer chose (`craft review post`; realm @nick/craft, nodes
//! #270, #271, #194): the review posts only defects and keeps the doubtful ones, numbered, in its run
//! record; for each the human picks "ask the author" or "post as a defect", and this posts that one —
//! read from the record, never from a hand-copied list — with the craft-finding marker, by the rules
//! the defects are posted by: not a second time when its comment is on the PR already, on its file
//! when GitHub refuses its line (node #285), only on a same-repository PR of the record's own
//! branch whose head holds the reviewed commit, on the
//! reviewed commit when the PR's head moved past it without touching its line, and nothing when it
//! did or the record names no reviewed commit.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::after::moved_over;
use super::gh::read;
use super::gh::{Moved, send::To};
use super::{Defect, PostSetup, body, short, sort};
use crate::gate::runner::Runner;

#[cfg(test)]
mod parity;
mod request;
mod target;

/// The doubtful finding to post, from its run record.
pub struct Doubtful<'a> {
    /// The record's `sorting.findings`.
    pub findings: &'a [Value],
    pub n: u64,
    /// A question to the author, else a defect.
    pub question: bool,
    /// The record's `sorting.inDiffJudged`: false puts the comment on its file.
    pub lines_judged: bool,
    /// The head the review read, when the record names it.
    pub reviewed: Option<&'a str>,
    /// The branch the review ran on, when the record names it.
    pub branch: Option<&'a str>,
}

/// What came of posting it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Posting {
    pub pr: u64,
    pub url: String,
    /// The commit the comment is on.
    pub commit: String,
    pub posted: bool,
    /// Its comment was on the PR already, so nothing was posted.
    pub already: bool,
    /// Posted on its file, its line outside the diff or refused by GitHub.
    pub to_file: bool,
    pub reason: String,
}

/// Why nothing was posted.
#[derive(Debug, thiserror::Error)]
pub enum PostError {
    /// The record lists no such finding, or it names no file.
    #[error("{0}")]
    Finding(String),
    /// The pull request cannot be told: none, several, one of another branch (`--pr`), or one
    /// whose head does not hold the reviewed commit.
    #[error("{0}")]
    Pr(String),
    /// gh failed, or the PR names no commit to post on.
    #[error("{0}")]
    Gh(String),
    /// The PR's head moved past the reviewed head over the finding's line.
    #[error("nothing was posted: {0}")]
    Refused(String),
}

/// Posts `d` on its branch's pull request (`pr`, checked against it, or the one open
/// same-repository PR of the record's branch, its head holding the reviewed commit), from the
/// checkout
/// `repo`, gh's output kept in `scratch`.
///
/// # Errors
/// As [`PostError`] says.
pub fn post(
    repo: &Path,
    d: &Doubtful<'_>,
    pr: Option<u64>,
    setup: &PostSetup,
    scratch: &Path,
) -> Result<Posting, PostError> {
    #[expect(
        clippy::cast_precision_loss,
        reason = "a finding's number, far below 2^53"
    )]
    let c = request::chosen(d.findings, d.n as f64, d.question, d.lines_judged)
        .map_err(PostError::Finding)?;
    let runner = Runner::new(setup.budget, setup.path.clone(), scratch.to_path_buf());
    let reviewed = target::full(d).ok_or_else(|| PostError::Refused(target::NO_REVIEWED.into()))?;
    let p = target::which_pr(&runner, repo, (d, reviewed), pr)?;

    let (commit, note) = if reviewed == p.head {
        (reviewed.to_owned(), String::new())
    } else {
        let line = sort::line(c.finding);
        let title = sort::text(c.finding, "title");
        let touched = |old: &crate::gate::lines::Lines| {
            (line > 0 && old.touches(&c.file, line))
                .then(|| format!("`{}:{line}` {title}", c.file))
                .into_iter()
                .collect()
        };
        match moved_over(repo, reviewed, &p.head, &touched) {
            Moved::Post(note) => (reviewed.to_owned(), format!(" · {note}")),
            Moved::Refuse(why) | Moved::Skip(why) => return Err(PostError::Refused(why)),
        }
    };
    let mut out = Posting {
        pr: p.number,
        url: p.url.clone(),
        commit,
        posted: false,
        already: false,
        to_file: false,
        reason: String::new(),
    };
    let seen = read::posted_already(&runner, repo, p.number).map_err(|e| {
        PostError::Gh(format!(
            "{e} — nothing posted, since what is there already could not be read"
        ))
    })?;
    let first = body::first_line(&c.body).to_owned();
    let on_line = (c.file.clone(), c.line.map_or(0, u64::from), first.clone());
    if seen.contains(&(c.file.clone(), 0, first)) || seen.contains(&on_line) {
        out.already = true;
        out.reason = format!(
            "its comment is on PR #{} {} already: nothing posted",
            p.number, p.url
        );
        return Ok(out);
    }
    let to = To {
        runner: &runner,
        repo,
        dir: scratch,
        pr: p.number,
        head: &out.commit,
    };
    let defect = Defect {
        finding: c.finding.clone(),
        file: c.file.clone(),
        line: c.line,
    };
    let refused = to
        .defect(usize::try_from(d.n).unwrap_or(0), &defect, &c.body)
        .map_err(PostError::Gh)?;
    (out.posted, out.to_file) = (true, refused || c.line.is_none());
    out.reason = format!(
        "posted on PR #{} {} at {}{note}",
        p.number,
        p.url,
        short(&out.commit)
    );
    Ok(out)
}
