//! A rejected thread as the memory skill's decision record, the shape both thread readers write
//! (realm @nick/craft, node #196: a human's call), anchored to the thread's line (node #230).

use craft_store::js::JsStr;
use serde_json::Value;

use super::Decision;
use super::rule::{Rejection, field};
use crate::js;

/// The thread's line on the commit it was posted on (`originalLine`, else `line`), when a
/// positive whole number (node #230).
fn anchor_line(t: &Value) -> Option<u64> {
    ["originalLine", "line"].iter().find_map(|k| {
        let n = t.get(*k)?.as_f64()?;
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a positive whole number below 2^53, checked first"
        )]
        (n.fract() == 0.0 && n > 0.0 && n < 9_007_199_254_740_992.0).then_some(n as u64)
    })
}

/// A rejected thread as the memory skill's decision record (node #196: a human's call).
pub(super) fn decision(
    t: &Value,
    (cs, title, scope, commit): (&[Value], &str, &str, &str),
    r: Rejection,
    (lens, tool_rule): (Option<String>, Option<String>),
) -> Decision {
    let root = cs.first().unwrap_or(&Value::Null);
    let last = cs.last().unwrap_or(&Value::Null);
    Decision {
        id: crate::memory::memory_record_id("decision", title, scope),
        kind: "decision",
        title: title.to_owned(),
        body: r.reason,
        scope: scope.to_owned(),
        status: "active",
        date: js::head(&field(last, "createdAt"), 10),
        author: r.by,
        decided_by: "human",
        commit: commit.to_owned(),
        links: [r.url, field(root, "url")]
            .into_iter()
            .filter(|l| !l.is_empty())
            .collect(),
        line: anchor_line(t),
        lens,
        tool_rule,
    }
}

const TITLE_MAX: usize = 200;
const REASON_MAX: usize = 1200;

/// What stops a rejection from becoming a record: no anchor, a scope carrying a line (node #606),
/// or a field past its bound. `None` when nothing does.
pub(super) fn problem(title: &str, scope: &str, commit: &str, reason: &str) -> Option<String> {
    let sha = (7..=40).contains(&commit.len()) && commit.bytes().all(|b| b.is_ascii_hexdigit());
    if scope.is_empty() || !sha {
        return Some("no path or commit to anchor the decision to".into());
    }
    let (path, line) = crate::memory::split_scope_line(scope);
    if path != scope.js_trim() {
        let quoted = serde_json::to_string(scope.js_trim()).unwrap_or_default();
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
