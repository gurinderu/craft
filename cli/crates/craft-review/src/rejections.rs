//! The PR author's and maintainers' rejections of review findings, read from a pull request's
//! review threads as decision records in the memory skill's shape — what addressing-findings
//! records before it works the findings, so the next review sets them aside (realm @nick/craft,
//! nodes #177, #302). A craft finding's thread is read by [`craft`], any other reviewer's by
//! [`remark`]; the threads come from `gh api graphql` ([`fetch`]). Held to what the JavaScript
//! reader printed by `content/parity/pr-rejections-cases.json`.

use craft_store::js::JsStr;
use serde::Serialize;
use serde_json::Value;

use crate::js;

mod comment;
mod craft;
pub mod fetch;
#[cfg(test)]
mod parity;
mod record;
mod remark;
mod rule;

/// The threads read across every page: past it, what was not read is named, never guessed at.
const THREADS_MAX: usize = 500;

/// A rejection as the memory skill's decision record, a human's (`decidedBy: "human"`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub id: String,
    pub kind: &'static str,
    pub title: String,
    pub body: String,
    pub scope: String,
    pub status: &'static str,
    pub date: String,
    pub author: String,
    pub decided_by: &'static str,
    pub commit: String,
    pub links: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lens: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_rule: Option<String>,
}

/// Every rejection recorded, and every thread whose rejection is not, with why.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Rejections {
    pub decisions: Vec<Decision>,
    pub skipped: Vec<String>,
}

/// Why an answer cannot be read.
#[derive(Debug, thiserror::Error)]
#[error(
    "not a reviewThreads answer (nor a slurped array of them): data.repository.pullRequest.reviewThreads.nodes is missing"
)]
pub struct NotAnAnswer;

/// The threads of one answer, or of every page of a slurped array of them, how many the PR has,
/// and its author: their login ('' when the answer does not carry it) and whether the PR is this
/// repository's own (`isCrossRepository: false` on a page; a fork's or an untold one is not).
fn threads(answer: &Value) -> Option<(Vec<&Value>, f64, rule::Author)> {
    let pages = answer
        .as_array()
        .map_or_else(|| vec![answer], |a| a.iter().collect());
    if pages.is_empty() {
        return None;
    }
    let (mut nodes, mut total, mut author) = (Vec::new(), 0.0, rule::Author::default());
    for page in pages {
        let pr = ["data", "repository", "pullRequest"]
            .iter()
            .try_fold(page, |v, k| v.get(*k))?;
        let t = pr.get("reviewThreads")?;
        nodes.extend(t.get("nodes")?.as_array()?);
        total = js::max(total, js::number(t.get("totalCount"), 0.0));
        if author.login.is_empty()
            && let Some(login) = pr
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(Value::as_str)
        {
            login.js_trim().clone_into(&mut author.login);
        }
        match pr.get("isCrossRepository").and_then(Value::as_bool) {
            Some(false) if !author.fork => author.same_repo = true,
            Some(true) => (author.same_repo, author.fork) = (false, true),
            _ => {}
        }
    }
    Some((nodes, total, author))
}

/// Every rejection in a `gh api graphql` reviewThreads answer.
///
/// # Errors
/// When the answer is not one.
pub fn from_answer(answer: &Value) -> Result<Rejections, NotAnAnswer> {
    let (nodes, total, author) = threads(answer).ok_or(NotAnAnswer)?;
    let mut out = Rejections::default();
    let read = nodes.get(..THREADS_MAX).unwrap_or(&nodes);
    for t in read {
        let d = match craft::decision(t, &author) {
            Ok(None) => remark::decision(t, &author),
            other => other,
        };
        match d {
            Ok(Some(d)) => out.decisions.push(d),
            Ok(None) => {}
            Err(why) => out.skipped.push(why),
        }
    }
    let count = |tail: &str| out.skipped.iter().filter(|s| s.ends_with(tail)).count();
    let tallies = [
        (
            count(craft::NOT_CRAFT_ROOT),
            "thread(s) not read as craft findings: the marked root comment's author is not OWNER/MEMBER/COLLABORATOR",
        ),
        (
            count(rule::NOT_AUTHORIZED),
            "rejection(s) not recorded: the replier is neither the PR author nor OWNER/MEMBER/COLLABORATOR",
        ),
        (
            count(rule::FORK_AUTHOR),
            "rejection(s) not recorded: the PR author of a PR not known to be this repository's own is not OWNER/MEMBER/COLLABORATOR",
        ),
        (
            count(remark::NOT_A_MAINTAINER),
            "rejection(s) of another reviewer's remark not recorded: the PR author is not OWNER/MEMBER/COLLABORATOR",
        ),
    ];
    for (n, said) in tallies {
        if n > 0 {
            out.skipped.push(format!("{n} {said}"));
        }
    }
    #[expect(clippy::cast_precision_loss, reason = "a PR's threads, far below 2^53")]
    let unread = js::max(total, nodes.len() as f64) - read.len() as f64;
    if unread > 0.0 {
        out.skipped.push(format!(
            "{} thread(s) past the {THREADS_MAX} read were not examined — nothing recorded from them",
            js::number_text(unread)
        ));
    }
    Ok(out)
}
