//! The thread of a reviewer that is not craft (realm @nick/craft, node #302), as
//! `reviewerThreadDecision` read it: its root any remark, its last word a rejection from an
//! OWNER/MEMBER/COLLABORATOR — here the PR author's word alone settles nothing, since an outside
//! author could post a remark under one account and reject it under another (node #186).

use serde_json::Value;

use super::Decision;
use super::rule::{self, ASSOCIATIONS, THREAD_COMMENTS_MAX, field, truthy};
use crate::js::{self, number_text, space};

/// A remark has no title line: its first line, cut at a word, stands in for one.
const TITLE_MAX: usize = 120;

/// The tail of the skip line for a PR author with no maintainer association rejecting a remark.
pub(super) const NOT_A_MAINTAINER: &str = "the PR author but not an owner, member or collaborator: another reviewer's remark is not theirs to settle, not recorded";

/// The title a remark stands under: its first line of text, heading, quote and emphasis marks
/// dropped, whitespace collapsed, cut at a word past [`TITLE_MAX`]; '' when it has none.
pub(super) fn title(body: &str) -> String {
    let first = body
        .split('\n')
        .map(|l| {
            let l = l.trim_start_matches(|c| space(c) || "#>*_-".contains(c));
            let l = l.trim_end_matches(|c| space(c) || "*_".contains(c));
            l.split(space)
                .filter(|w| !w.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let units: Vec<u16> = first.encode_utf16().collect();
    let Some(cut) = units.get(..TITLE_MAX).filter(|_| units.len() > TITLE_MAX) else {
        return first;
    };
    let at = cut
        .iter()
        .rposition(|&u| u == u16::from(b' '))
        .filter(|&a| a > TITLE_MAX / 2);
    let kept = String::from_utf16_lossy(at.and_then(|a| cut.get(..a)).unwrap_or(cut));
    format!("{}…", kept.trim_end_matches(space))
}

/// One thread whose root is not a craft finding as a decision record (`Ok(Some)`), why its
/// rejection is not recorded (`Err`), or `Ok(None)` when it holds no rejection at all.
pub(super) fn decision(t: &Value, pr_author: &str) -> Result<Option<Decision>, String> {
    let (cs, total) = rule::comments(t);
    let Some(root) = cs.first().filter(|r| truthy(r)) else {
        return Ok(None);
    };
    if cs.len() < 2 {
        return Ok(None);
    }
    let title = title(&js::text(root.get("body")));
    let scope = field(t, "path");
    let reviewer = rule::login(root);
    let or = |s: &str, d: &str| {
        if s.is_empty() {
            d.to_owned()
        } else {
            s.to_owned()
        }
    };
    let shown = format!(
        "{}: {} (reviewer {})",
        or(&scope, "?"),
        or(&title, "(remark without text)"),
        or(&reviewer, "?")
    );
    let at = |why: String| format!("{shown} — {why}");
    #[expect(
        clippy::cast_precision_loss,
        reason = "a page of at most a few hundred comments"
    )]
    if total > cs.len() as f64 {
        return Err(at(format!(
            "{} comments, past the {THREAD_COMMENTS_MAX} read: the last word is unknown",
            number_text(total)
        )));
    }
    let r = match rule::rejection(cs, pr_author) {
        Ok(r) => r,
        Err(why) if why.starts_with("rejected by") => return Err(at(why)),
        Err(_) => return Ok(None),
    };
    let commit = field(root.get("originalCommit").unwrap_or(&Value::Null), "oid");
    let assoc = rule::association(cs.last().unwrap_or(&Value::Null));
    let problem = if !ASSOCIATIONS.contains(&assoc.as_str()) {
        Some(rule::rejected_by(&r.by, &assoc, NOT_A_MAINTAINER))
    } else if title.is_empty() {
        Some("the remark has no text to title the decision: record it by hand".into())
    } else {
        rule::problem(&title, &scope, &commit, &r.reason)
    };
    if let Some(p) = problem {
        return Err(at(p));
    }
    Ok(Some(super::record::decision(
        t,
        (cs, &title, &scope, &commit),
        r,
        (None, None),
    )))
}
