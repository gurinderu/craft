//! The inline PR comment of a finding, as the JavaScript `findingCommentBody` wrote it (frozen in
//! `content/parity/sort-cases.json` and `finding-post-cases.json`): `[Severity] title`, the reason and the fix, the hidden lens and tool-rule lines when they fit,
//! a question's ask and kind line, and the craft-finding marker last (realm @nick/craft, nodes #194,
//! #230, #236, #271) — what lets a later
//! session tie a reply in the thread to its finding, and a later run see it is posted already.

use craft_store::js::JsStr;
use serde_json::Value;

use super::sort::text;

/// The hidden line that marks a comment as craft's finding (`FINDING_COMMENT_MARKER`).
pub(crate) const MARKER: &str = "<!-- craft-finding -->";

/// A value as one line (`commentLine`).
fn one_line(s: &str) -> String {
    s.js_split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether `v` is 1 to `max` characters, each a letter, a digit or one of `extra` — what the
/// hidden lines' patterns admit (`LENS_LINE`, `TOOL_RULE_LINE`).
pub(crate) fn fits(v: &str, max: usize, extra: &str) -> bool {
    (1..=max).contains(&v.chars().count())
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

/// What the hidden lens line admits (`LENS_LINE`): its longest value and the characters beside
/// letters and digits.
pub(crate) const LENS: (usize, &str) = (80, "_,:/. -");
/// What the hidden tool-rule line admits (`TOOL_RULE_LINE`).
pub(crate) const RULE: (usize, &str) = (120, "_:/.@#-");
/// The hidden line of a question to the author (`KIND_LINE`; realm @nick/craft, node #271).
pub(crate) const QUESTION_LINE: &str = "<!-- craft-kind: question -->";
/// What a question comment asks, visibly, under its first line (`QUESTION_ASK`).
const QUESTION_ASK: &str = "**Question to the author:** is this a defect here, or intended? It turns on something you know — reply with the reason (\"not a bug: …\", \"by design: …\"), or fix it.";

/// The comment body of a defect.
pub(super) fn defect(f: &Value) -> String {
    comment(f, false)
}

/// The comment body of a finding, as a question to the author when `question` (its ask under the
/// first line, its kind line before the marker), else as a defect.
pub(super) fn comment(f: &Value, question: bool) -> String {
    let lens = one_line(&text(f, "source"));
    let rule = one_line(&text(f, "toolRule"));
    let lens = if fits(&lens, LENS.0, LENS.1) {
        format!("<!-- craft-lens: {lens} -->\n")
    } else {
        String::new()
    };
    let rule = if fits(&rule, RULE.0, RULE.1) {
        format!("<!-- craft-tool-rule: {rule} -->\n")
    } else {
        String::new()
    };
    let (ask, kind) = if question {
        (format!("{QUESTION_ASK}\n\n"), format!("{QUESTION_LINE}\n"))
    } else {
        (String::new(), String::new())
    };
    format!(
        "[{}] {}\n\n{ask}{} — {}\n\n{lens}{rule}{kind}{MARKER}",
        one_line(&text(f, "severity")),
        one_line(&text(f, "title")),
        text(f, "why").js_trim(),
        text(f, "fix").js_trim()
    )
}

/// The first line of a comment body: what, beside its file, tells one finding's comment from
/// another's.
pub(super) fn first_line(body: &str) -> &str {
    body.lines().next().unwrap_or("").js_trim()
}
