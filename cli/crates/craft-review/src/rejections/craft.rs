//! The thread of a craft finding (realm @nick/craft, nodes #177, #186): its root a craft finding
//! comment posted by an OWNER/MEMBER/COLLABORATOR — anyone else can paste the marker — and its
//! last word a rejection, as `threadDecision` read it.

use serde_json::Value;

use super::Decision;
use super::rule::{self, ASSOCIATIONS, THREAD_COMMENTS_MAX, field, truthy};
use crate::js::number_text;

/// The tail of the skip line for a marked root from an account with no such association.
pub(super) const NOT_CRAFT_ROOT: &str =
    "who is not an owner, member or collaborator: not a craft finding, not recorded";

/// One thread as a decision record (`Ok(Some)`), why it is not one (`Err`), or `Ok(None)` when its
/// root is not a craft finding at all.
pub(super) fn decision(t: &Value, pr_author: &rule::Author) -> Result<Option<Decision>, String> {
    let (cs, total) = rule::comments(t);
    let Some(root) = cs.first().filter(|r| truthy(r)) else {
        return Ok(None);
    };
    let Some(finding) = super::comment::read(&crate::js::text(root.get("body"))) else {
        return Ok(None);
    };
    let scope = field(t, "path");
    let shown = if scope.is_empty() { "?" } else { &scope };
    let at = |why: String| format!("{shown}: {} — {why}", finding.title);
    let assoc = rule::association(root);
    if !ASSOCIATIONS.contains(&assoc.as_str()) {
        let by = rule::login(root);
        let or = |s: &str, d: &str| {
            if s.is_empty() {
                d.to_owned()
            } else {
                s.to_owned()
            }
        };
        return Err(at(format!(
            "the finding comment was posted by {} (association {}), {NOT_CRAFT_ROOT}",
            or(&by, "?"),
            or(&assoc, "unknown")
        )));
    }
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
    let r = rule::rejection(cs, pr_author).map_err(at)?;
    let commit = field(root.get("originalCommit").unwrap_or(&Value::Null), "oid");
    if let Some(p) = super::record::problem(&finding.title, &scope, &commit, &r.reason) {
        return Err(at(p));
    }
    Ok(Some(super::record::decision(
        t,
        (cs, &finding.title, &scope, &commit),
        r,
        (finding.lens, finding.tool_rule),
    )))
}
