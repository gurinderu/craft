//! Posting one doubtful finding the reviewer chose (`craft review post`; realm @nick/craft, nodes
//! #270, #271, #194): the review posts only defects and keeps the doubtful ones, numbered, in its run
//! record; for each the human picks "ask the author" or "post as a defect", and this posts that one —
//! read from the record, never from a hand-copied list — with the craft-finding marker, by the rules
//! the defects are posted by: not a second time when its comment is on the PR already, on its file
//! when GitHub refuses its line (node #285) — found before the PR's state and head are judged, so a
//! retry sees its own earlier comment —, only on an open same-repository PR of the record's own
//! branch whose head holds the reviewed commit, never from a review of uncommitted work, on the
//! reviewed commit when the PR's head moved past it without touching its line, and nothing when it
//! did or the record names no reviewed commit.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::gh::read;
use super::gh::send::To;
use super::{Defect, PostSetup, body, short};
use crate::gate::runner::Runner;

pub use error::PostError;

mod error;
mod head;
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
    /// The PR the run published on (`prComments.pr`), when it names one.
    pub record_pr: Option<u64>,
    /// The review read uncommitted work (the record's `dirty`): its lines are not the PR's, and
    /// nothing is posted.
    pub dirty: bool,
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
    if d.dirty {
        return Err(PostError::Refused(super::DIRTY.into()));
    }
    let runner = Runner::new(setup.budget, setup.path.clone(), scratch.to_path_buf());
    let reviewed = target::full(d).ok_or_else(|| PostError::Refused(target::NO_REVIEWED.into()))?;
    let p = target::which_pr(&runner, repo, d, pr)?;
    let mut out = Posting {
        pr: p.number,
        url: p.url.clone(),
        commit: reviewed.to_owned(),
        posted: false,
        already: false,
        to_file: false,
        reason: String::new(),
    };
    // Before the PR's state and head are judged: a retry finds the comment it posted already
    // even once the PR closed or its head moved over the line.
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
    head::postable(repo, &p, reviewed)?;
    let note = head::commit_for(repo, &c, reviewed, &p)?;
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
