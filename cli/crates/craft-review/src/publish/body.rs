//! The inline PR comment of a defect, as `findingCommentBody` in `lib/finding-comment.mjs` writes
//! it: `[Severity] title`, the reason and the fix, the hidden lens and tool-rule lines when they fit,
//! and the craft-finding marker last (realm @nick/craft, nodes #194, #230, #236) — what lets a later
//! session tie a reply in the thread to its finding, and a later run see it is posted already.

use serde_json::Value;

use super::sort::text;

/// The hidden line that marks a comment as craft's finding (`FINDING_COMMENT_MARKER`).
pub(super) const MARKER: &str = "<!-- craft-finding -->";

/// A value as one line (`commentLine`).
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether `v` is 1 to `max` characters, each a letter, a digit or one of `extra` — what the
/// hidden lines' patterns admit (`LENS_LINE`, `TOOL_RULE_LINE`).
fn fits(v: &str, max: usize, extra: &str) -> bool {
    (1..=max).contains(&v.chars().count())
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

/// The comment body of a defect.
pub(super) fn defect(f: &Value) -> String {
    let lens = one_line(&text(f, "source"));
    let rule = one_line(&text(f, "toolRule"));
    let lens = if fits(&lens, 80, "_,:/. -") {
        format!("<!-- craft-lens: {lens} -->\n")
    } else {
        String::new()
    };
    let rule = if fits(&rule, 120, "_:/.@#-") {
        format!("<!-- craft-tool-rule: {rule} -->\n")
    } else {
        String::new()
    };
    format!(
        "[{}] {}\n\n{} — {}\n\n{lens}{rule}{MARKER}",
        one_line(&text(f, "severity")),
        one_line(&text(f, "title")),
        text(f, "why").trim(),
        text(f, "fix").trim()
    )
}

/// The first line of a comment body: what, beside its file, tells one finding's comment from
/// another's.
pub(super) fn first_line(body: &str) -> &str {
    body.lines().next().unwrap_or("").trim()
}
