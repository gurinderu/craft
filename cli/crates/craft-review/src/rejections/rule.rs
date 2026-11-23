//! What the two thread readers share, as the JavaScript reader held it (frozen in
//! `content/parity/pr-rejections-cases.json`; realm
//! @nick/craft, nodes #177, #182, #185, #196): the last word a rejection only when it opens with a
//! rejection phrase and comes from an OWNER/MEMBER/COLLABORATOR or the author of a PR of this
//! repository's own (never a fork's: its author is an outside contributor).

use std::sync::LazyLock;

use serde_json::Value;

use crate::js::{self, str_of};

/// One page of comments per thread (`comments(first: 50)`): past it, the last word is unknown.
pub(super) const THREAD_COMMENTS_MAX: usize = 50;

/// Who may reject besides the PR author (node #182).
pub(super) const ASSOCIATIONS: [&str; 3] = ["OWNER", "MEMBER", "COLLABORATOR"];
/// The tail of the skip line for a rejection from anyone else.
pub(super) const NOT_AUTHORIZED: &str =
    "who is neither the PR author nor an owner, member or collaborator: not recorded";

/// The tail of the skip line for a PR author with no such association whose PR is a fork's, or not
/// known to be this repository's own: an outside contributor does not settle a finding on their
/// own PR as a human decision would.
pub(super) const FORK_AUTHOR: &str = "the PR author, but the PR is not known to be this repository's own (a fork's, or an answer that does not say) and they are not an owner, member or collaborator: not recorded";

/// The PR's author as the thread rules read it.
#[derive(Debug, Default)]
pub(super) struct Author {
    pub(super) login: String,
    /// The answer says the PR's head is in this repository (`isCrossRepository: false`).
    pub(super) same_repo: bool,
    /// A page says it is a fork's: no page outweighs that.
    pub(super) fork: bool,
}

/// A reply rejects only when it opens with one of these; JavaScript's `/i` folds ASCII only, and
/// its `\b` is ASCII's.
static REJECTION: LazyLock<Option<regex::Regex>> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i-u)^(?:(?:this|it|that)(?: is|'s) )?(?:not a bug|not an issue|by design|won'?t fix|wontfix|will not fix|works as intended|working as intended|as intended|intentional|false positive)(?-u:\b)",
    )
    .ok()
});

/// A comment's field, as `str` read it.
pub(super) fn field(c: &Value, k: &str) -> String {
    str_of(c.get(k))
}

/// The login of a comment's author.
pub(super) fn login(c: &Value) -> String {
    str_of(c.get("author").and_then(|a| a.get("login")))
}

/// A comment's author association, upper-cased.
pub(super) fn association(c: &Value) -> String {
    field(c, "authorAssociation").to_uppercase()
}

/// The rejection a thread's comments carry: who, the reason, its link — or why there is none.
pub(super) struct Rejection {
    pub(super) by: String,
    pub(super) reason: String,
    pub(super) url: String,
}

pub(super) fn rejection(cs: &[Value], pr_author: &Author) -> Result<Rejection, String> {
    let last = cs.last().unwrap_or(&Value::Null);
    if cs.len() == 1 {
        return Err("no reply — only an explicit rejection reply counts".into());
    }
    let reason = field(last, "body");
    if !REJECTION.as_ref().is_some_and(|r| r.is_match(&reason)) {
        return Err("the last reply does not open with a rejection".into());
    }
    let (by, assoc) = (login(last), association(last));
    let author = !by.is_empty() && by == pr_author.login;
    if !ASSOCIATIONS.contains(&assoc.as_str()) {
        if !author {
            return Err(rejected_by(&by, &assoc, NOT_AUTHORIZED));
        }
        if !pr_author.same_repo {
            return Err(rejected_by(&by, &assoc, FORK_AUTHOR));
        }
    }
    Ok(Rejection {
        by,
        reason,
        url: field(last, "url"),
    })
}

/// `rejected by <who> (association <a>), <tail>`.
pub(super) fn rejected_by(by: &str, assoc: &str, tail: &str) -> String {
    let or = |s: &str, d: &str| {
        if s.is_empty() {
            d.to_owned()
        } else {
            s.to_owned()
        }
    };
    format!(
        "rejected by {} (association {}), {tail}",
        or(by, "?"),
        or(assoc, "unknown")
    )
}

/// Whether JavaScript reads `v` as true: a thread's root that is not is no root.
pub(super) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A thread's comments, its root and how many it has in all.
pub(super) fn comments(t: &Value) -> (&[Value], f64) {
    let nodes = t.get("comments").and_then(|c| c.get("nodes"));
    let cs = nodes
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    #[expect(
        clippy::cast_precision_loss,
        reason = "a page of at most a few hundred comments"
    )]
    let total = js::number(
        t.get("comments").and_then(|c| c.get("totalCount")),
        cs.len() as f64,
    );
    (cs, total)
}
