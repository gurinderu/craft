//! What the two thread readers share, as the JavaScript reader held it (frozen in
//! `content/parity/pr-rejections-cases.json`; realm
//! @nick/craft, nodes #177, #182, #185, #196): the last word a rejection only when it opens with a
//! rejection phrase and comes from the PR author or an OWNER/MEMBER/COLLABORATOR, and what keeps
//! one from becoming a record.

use std::sync::LazyLock;

use serde_json::Value;

use crate::js::{self, str_of};

/// One page of comments per thread (`comments(first: 50)`): past it, the last word is unknown.
pub(super) const THREAD_COMMENTS_MAX: usize = 50;
const TITLE_MAX: usize = 200;
const REASON_MAX: usize = 1200;

/// Who may reject besides the PR author (node #182).
pub(super) const ASSOCIATIONS: [&str; 3] = ["OWNER", "MEMBER", "COLLABORATOR"];
/// The tail of the skip line for a rejection from anyone else.
pub(super) const NOT_AUTHORIZED: &str =
    "who is neither the PR author nor an owner, member or collaborator: not recorded";

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

pub(super) fn rejection(cs: &[Value], pr_author: &str) -> Result<Rejection, String> {
    let last = cs.last().unwrap_or(&Value::Null);
    if cs.len() == 1 {
        return Err("no reply — only an explicit rejection reply counts".into());
    }
    let reason = field(last, "body");
    if !REJECTION.as_ref().is_some_and(|r| r.is_match(&reason)) {
        return Err("the last reply does not open with a rejection".into());
    }
    let (by, assoc) = (login(last), association(last));
    let author = !by.is_empty() && by == pr_author;
    if !author && !ASSOCIATIONS.contains(&assoc.as_str()) {
        return Err(rejected_by(&by, &assoc, NOT_AUTHORIZED));
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

/// What stops a rejection from becoming a record: no anchor, a scope carrying a line (node #606),
/// or a field past its bound. `None` when nothing does.
pub(super) fn problem(title: &str, scope: &str, commit: &str, reason: &str) -> Option<String> {
    let sha = (7..=40).contains(&commit.len()) && commit.bytes().all(|b| b.is_ascii_hexdigit());
    if scope.is_empty() || !sha {
        return Some("no path or commit to anchor the decision to".into());
    }
    let (path, line) = crate::memory::split_scope_line(scope);
    if path != js::trim(scope) {
        let quoted = serde_json::to_string(js::trim(scope)).unwrap_or_default();
        return Some(format!(
            "scope {quoted} carries a line: write scope={path}, line={line}"
        ));
    }
    if js::len(title) > TITLE_MAX {
        return Some(format!("title over {TITLE_MAX} chars: record it by hand"));
    }
    let n = js::len(reason);
    (n > REASON_MAX)
        .then(|| format!("reason is {n} chars, over {REASON_MAX}: summarise it and record by hand"))
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
