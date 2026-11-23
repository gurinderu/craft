//! Posting one doubtful finding the reviewer chose (`craft review post`; realm @nick/craft, nodes
//! #270, #271, #194): the review posts only defects and keeps the doubtful ones, numbered, in its run
//! record; for each the human picks "ask the author" or "post as a defect", and this posts that one —
//! read from the record, never from a hand-copied list — with the craft-finding marker, by the rules
//! the defects are posted by: never from a review of uncommitted work; only on an open
//! same-repository PR of the record's own branch whose head holds the reviewed commit — a retry
//! whose PR closed names it with `--pr`; not a second time when its comment is on the PR already
//! (on the record's own PR found before the head is judged, so a retry sees its earlier comment
//! after the head moved); on its file when GitHub refuses its line (node #285); on the reviewed
//! commit when the PR's head moved past it without touching its line, and nothing when it did or
//! the record names no reviewed commit.

use std::path::Path;

use serde_json::Value;

use super::gh::send::To;
use super::{Defect, PostSetup, short};
use crate::gate::runner::Runner;
use target::Found;

pub use error::PostError;
pub use posting::Posting;

mod error;
mod head;
#[cfg(test)]
mod parity;
mod posting;
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
    /// The review read uncommitted work (`diff.dirty` of the run's state, as the review judged it):
    /// its lines are not the PR's, and nothing is posted.
    pub dirty: bool,
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
    // The record's own PR, no --pr given, must be open; its comments are read before its head is
    // judged, so a retry finds what it posted even once the head moved. A PR named with --pr,
    // closed or not, first shows it holds the reviewed commit.
    let p = match target::which_pr(&runner, repo, d, pr)? {
        Found::Own(p) => {
            if p.state != "OPEN" {
                return Err(PostError::Pr(format!(
                    "PR #{} is not open: {}",
                    p.number,
                    target::NAME_IT
                )));
            }
            p
        }
        Found::Named(p) => {
            head::holding(repo, &p, reviewed)?;
            p
        }
    };
    if head::already(&runner, repo, &p, &c)? {
        return Ok(Posting::already(&p, reviewed));
    }
    head::open(&p)?;
    head::holding(repo, &p, reviewed)?;
    let mut out = Posting {
        pr: p.number,
        url: p.url.clone(),
        commit: reviewed.to_owned(),
        posted: false,
        already: false,
        to_file: false,
        reason: String::new(),
    };
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
