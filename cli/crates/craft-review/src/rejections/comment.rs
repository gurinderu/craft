//! A PR comment read back as the craft finding it carries, as `readFindingComment` read it: the
//! craft-finding marker anywhere, a first line `[Severity] title`, and the hidden lens and tool-rule
//! lines when the body holds them (a question's kind line no record carries) (realm @nick/craft, nodes #194, #230, #236, #271). A
//! comment without them is not craft's, and nothing is recorded from it as a finding.

use crate::js::{is_space, trim};
use crate::publish::body::{LENS, MARKER, RULE, fits};

/// The finding a comment carries.
pub(super) struct Finding {
    pub(super) title: String,
    pub(super) lens: Option<String>,
    pub(super) tool_rule: Option<String>,
}

const SEVERITIES: [&str; 5] = ["critical", "high", "medium", "low", "info"];

/// The finding `body` carries, or `None` when it is not a craft finding comment.
pub(super) fn read(body: &str) -> Option<Finding> {
    if !body.contains(MARKER) {
        return None;
    }
    let first = trim(body.split('\n').next().unwrap_or(""));
    let (severity, rest) = first.strip_prefix('[')?.split_once("] ")?;
    let starts = rest.chars().next().is_some_and(|c| !is_space(c));
    let one_line = !rest.contains(['\r', '\u{2028}', '\u{2029}']);
    if !SEVERITIES.contains(&severity.to_ascii_lowercase().as_str()) || !starts || !one_line {
        return None;
    }
    Some(Finding {
        title: trim(rest).to_owned(),
        lens: hidden(body, "<!-- craft-lens: ", LENS),
        tool_rule: hidden(body, "<!-- craft-tool-rule: ", RULE),
    })
}

/// The value of the first line of `body` that is `<prefix><value> -->`, the value fitting `fit`,
/// trimmed; `None` when no line is, or its value is blank. Lines end where JavaScript's `^`/`$`
/// end them in multiline mode.
fn hidden(body: &str, prefix: &str, fit: (usize, &str)) -> Option<String> {
    let value = body
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .filter_map(|l| l.strip_prefix(prefix)?.strip_suffix(" -->"))
        .find(|v| fits(v, fit.0, fit.1))?;
    let v = trim(value);
    (!v.is_empty()).then(|| v.to_owned())
}
