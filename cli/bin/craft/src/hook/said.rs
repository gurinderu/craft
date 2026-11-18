//! What the pre-PR check says (realm @nick/craft, node #541): one line for the human
//! (`systemMessage`), shown before the command runs, and one for the model (`additionalContext`),
//! which reaches it only after the command ran (#289) — so it speaks of a pull request already
//! opened. Nothing when the head has its full review.

use serde_json::{Value, json};

use super::here::Here;
use super::runs::{Found, LastRun, Scope};

const OFFER: &str = "Tell the human, and offer to run one — the craft:review workflow on this branch in Claude Code, or `craft review run --backend codex|pi|opencode` on another host. This warns; it did not stop the command.";

/// The hook's output for `found` at `here`; `None` when there is nothing to say.
pub fn said(found: &Found, here: &Here) -> Option<Value> {
    let head = head_of(here);
    match found {
        Found::Reviewed => None,
        Found::Missing {
            last,
            crates_only,
            malformed,
        } => {
            let last = last_run(last.as_ref(), here);
            let crates = if *crates_only {
                " A rust-audit covered only the crates; the rest of the change has no full review."
            } else {
                ""
            };
            let skipped = match malformed {
                0 => String::new(),
                n => format!(" ({n} unreadable line(s) of the run store's index passed over.)"),
            };
            Some(output(
                &format!(
                    "craft: opening a PR with no full craft review on this head ({head}); {last}.{crates} Run craft:review on it before the pull request, or say why it goes without one."
                ),
                &format!(
                    "craft: the pull request was opened without a full craft review of its head ({head}): the run store holds no finished craft:review or craft:rust-audit run of the PR's whole change on it (not delta, light, path-scoped, dirty, INCOMPLETE, PARTIAL COVERAGE, gate-red or nested, and on origin's default branch's merge-base); {last}.{crates}{skipped} {OFFER}"
                ),
            ))
        }
        Found::NoStore(why) => Some(could_not(&format!(
            "the run store is not readable for this head ({head}) — {why}"
        ))),
    }
}

/// The output when the check could not be made, and why.
pub fn could_not(why: &str) -> Value {
    output(
        &format!("craft: could not check for a full craft review before the PR: {why}."),
        &format!(
            "craft: whether the pull request's head has a full craft review could not be checked: {why}. {OFFER}"
        ),
    )
}

/// The output when an earlier command of the chain, `by`, moves HEAD before the PR is opened.
pub fn moved(by: &str) -> Value {
    output(
        &format!(
            "craft: could not check before the PR: the command changes the branch first (`{by}`) — run the review on the final head."
        ),
        &format!(
            "craft: the pull request was opened after `{by}` changed the branch in the same command, so whether its head has a full craft review could not be checked. {OFFER}"
        ),
    )
}

fn output(human: &str, model: &str) -> Value {
    json!({
        "systemMessage": human,
        "hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": model},
    })
}

fn head_of(here: &Here) -> String {
    match &here.named {
        Some(b) => format!("{}, the tip of {b} that --head names", short(&here.head)),
        None => short(&here.head).to_owned(),
    }
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
