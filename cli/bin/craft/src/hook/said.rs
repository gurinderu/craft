//! What the PR-opened check says (realm @nick/craft, node #541): one line for the human
//! (`systemMessage`) and one for the model (`additionalContext`), both after the PR was opened.
//! Nothing when its head has its full review.

use serde_json::{Value, json};

use super::repo::Here;
use super::runs::{Found, LastRun, Scope};

const OFFER: &str = "Tell the human, and offer to run one — the craft:review workflow on this head in Claude Code, or `craft review run --backend codex|pi|opencode` on another host. This warns; it did not stop the command.";

/// The hook's output for `found` on the PR at `url`; `None` when there is nothing to say.
pub fn said(found: &Found, url: &str, here: &Here) -> Option<Value> {
    match found {
        Found::Reviewed => None,
        Found::Missing { last, malformed } => {
            let last = last_run(last.as_ref(), &here.branch);
            let skipped = match malformed {
                0 => String::new(),
                n => format!(" ({n} unreadable line(s) of the run store's index passed over.)"),
            };
            Some(output(
                &format!(
                    "craft: PR {url} was opened with no full craft review of its head {} (last run: {last}).",
                    short(&here.head)
                ),
                &format!(
                    "craft: the pull request {url} was opened with no full craft review of its head {}: the run store holds no finished craft:review run of the PR's whole change on that head (not delta, light, path-scoped, dirty, partial, nested, INCOMPLETE or PARTIAL COVERAGE, its lenses run with nothing left unrun, over {} or its merge-base); the last run on {}: {last}.{skipped} {OFFER}",
                    here.head, here.trunk, here.branch
                ),
            ))
        }
        Found::NoStore(why) => Some(could_not(
            Some(url),
            &format!("the run store is not readable ({why})"),
        )),
    }
}

/// The output when the check could not be made for the PR at `url`, and why.
pub fn could_not(url: Option<&str>, why: &str) -> Value {
    let pr = url.map_or_else(|| "the opened PR".to_owned(), |u| format!("PR {u}"));
    output(
        &format!("craft: could not check {pr} for a full craft review: {why}."),
        &format!(
            "craft: whether {pr} has a full craft review of its head could not be checked: {why}. {OFFER}"
        ),
    )
}

fn output(human: &str, model: &str) -> Value {
    json!({
        "systemMessage": human,
        "hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": model},
    })
}

fn last_run(last: Option<&LastRun>, branch: &str) -> String {
    let Some(r) = last else {
        return format!("none filed for {branch}");
    };
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
    format!("{}, {verdict}, {scope}, {}", short(&r.head), when(&r.ts))
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
