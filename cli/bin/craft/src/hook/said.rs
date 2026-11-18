//! What the pre-PR check says (realm @nick/craft, node #541): one line for the human
//! (`systemMessage`) and one for the model (`additionalContext`), in the `PreToolUse` output Claude
//! Code reads; nothing when the head has its full review.

use serde_json::{Value, json};

use super::runs::{Found, Here, LastRun, Scope};

/// The hook's output for `found` at `here`; `None` when there is nothing to say.
pub fn said(found: &Found, here: &Here) -> Option<Value> {
    let head = short(&here.head);
    let (human, model) = match found {
        Found::Reviewed => return None,
        Found::Missing { last, malformed } => {
            let last = last_run(last.as_ref(), here);
            let skipped = match malformed {
                0 => String::new(),
                n => format!(" ({n} unreadable line(s) of the run store's index passed over.)"),
            };
            (
                format!(
                    "craft: no full craft review on this head ({head}); {last}. Run craft:review or craft:rust-audit before the pull request, or say why it goes without one."
                ),
                format!(
                    "craft: no full craft review on this head ({head}): the run store holds no finished, full craft:review or craft:rust-audit run (not delta, not INCOMPLETE, not nested) on it; {last}.{skipped} Tell the human before the pull request is opened, then run one — the craft:review or craft:rust-audit workflow on this branch in Claude Code, or `craft review run --backend codex|pi|opencode` on another host — or say why this pull request goes without it. This warns; it does not stop the command."
                ),
            )
        }
        Found::NoStore(why) => {
            let text = format!(
                "craft: could not check for a craft review on this head ({head}): the run store is not readable — {why}. No craft review is known for this pull request."
            );
            (text.clone(), text)
        }
    };
    Some(json!({
        "systemMessage": human,
        "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": model},
    }))
}

fn last_run(last: Option<&LastRun>, here: &Here) -> String {
    match (last, here.branch.as_deref()) {
        (Some(r), Some(branch)) => {
            let scope = match r.scope {
                Scope::Full => "full",
                Scope::Delta => "delta",
                Scope::Unknown => "scope unknown",
            };
            let verdict = if r.verdict.is_empty() {
                "no verdict"
            } else {
                &r.verdict
            };
            format!(
                "the last craft review of {branch}: {}, {verdict}, {scope}, {}",
                short(&r.head),
                when(&r.ts)
            )
        }
        (None, Some(branch)) => format!("no craft review is filed for {branch}"),
        (_, None) => "HEAD is detached, so no branch's last run is named".into(),
    }
}

fn short(sha: &str) -> &str {
    sha.get(..12).unwrap_or(sha)
}

/// A store timestamp (`YYYY-MM-DDTHH-MM-SSZ`) as a reader writes a time; any other shape as it is.
fn when(ts: &str) -> String {
    match ts.strip_suffix('Z').and_then(|t| t.split_once('T')) {
        Some((day, time)) if time.len() == 8 => format!("{day} {} UTC", time.replace('-', ":")),
        _ => ts.to_owned(),
    }
}

#[cfg(test)]
#[path = "said_tests.rs"]
mod tests;
