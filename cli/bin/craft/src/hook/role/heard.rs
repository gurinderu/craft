//! What the hook log says about a session (realm @nick/craft, node #288): whether the prompt
//! hook's lines are still in its context, whether the re-review nudge was said there, and the kind
//! a bare continuation takes. The lines of Claude Code, Codex and OpenCode alike.

use serde_json::Value;

use super::entry::{event, field, has};
use super::iso;
use super::kind::Kind;

pub const NUDGE: &str = "re-review-nudge";
/// The `reason` of the one line a later prompt in another script hears.
pub const REMINDER: &str = "language-reminder";
// OpenCode's events for the same moments: a main session's message, its compaction.
const OPENCODE_PROMPT: &str = "chat.message";
const OPENCODE_RESET: &str = "session.compacted";
/// How far back a session's first continuation reaches into the repo's other sessions.
const WINDOW_MS: i64 = 12 * 60 * 60 * 1000;

fn in_session(e: &Value, session: &str) -> bool {
    field(e, "session") == Some(session)
}

/// A line that empties its session's context.
fn reset(e: &Value) -> bool {
    let ev = event(e);
    ev == "SessionStart" && matches!(field(e, "source"), Some("compact" | "clear"))
        || ev == OPENCODE_RESET
}

/// The session's lines since its context was last emptied.
fn since_reset<'a>(log: &'a [Value], session: &str) -> Vec<&'a Value> {
    let mut mine = Vec::new();
    for e in log.iter().filter(|e| in_session(e, session)) {
        if reset(e) {
            mine.clear();
        } else {
            mine.push(e);
        }
    }
    mine
}

fn spoke(e: &Value) -> bool {
    e.get("spoke").and_then(Value::as_bool) == Some(true)
}

/// The prompt hook speaking a request's text in a main session, for one of `kinds`.
fn prompt_spoke(e: &Value, kinds: Option<&[&str]>) -> bool {
    let ev = event(e);
    let prompt = ev == "UserPromptSubmit" || ev == OPENCODE_PROMPT && !has(e, "agent");
    prompt
        && spoke(e)
        && !has(e, "reason")
        && kinds.is_none_or(|k| field(e, "kind").is_some_and(|kind| k.contains(&kind)))
}

/// Whether the prompt hook's lines (for one of `kinds`, when given) are still in the session's
/// context.
pub fn said_in_session(log: &[Value], session: &str, kinds: Option<&[&str]>) -> bool {
    since_reset(log, session)
        .into_iter()
        .any(|e| prompt_spoke(e, kinds))
}

/// Whether the re-review nudge was said in the session's context.
pub fn nudged_in_session(log: &[Value], session: &str) -> bool {
    since_reset(log, session)
        .into_iter()
        .any(|e| field(e, "reason") == Some(NUDGE))
}

/// The kinds whose text, once said, makes the text for `kind` unneeded: each covers its own;
/// Codex's one English text names both English kinds.
fn covered_by(codex: bool, kind: Kind) -> Vec<&'static str> {
    if codex && kind != Kind::OtherLanguage {
        vec!["findings", "review"]
    } else {
        vec![kind.name()]
    }
}

/// What a prompt of `kind` hears when its text was already said: nothing for a per-kind text
/// (`already-said`), the reminder for the conditional one; `None` when that text is not there.
pub fn repeat_of(log: &[Value], session: &str, codex: bool, kind: Kind) -> Option<&'static str> {
    if !said_in_session(log, session, Some(&covered_by(codex, kind))) {
        return None;
    }
    Some(if kind == Kind::OtherLanguage {
        REMINDER
    } else {
        "already-said"
    })
}

/// A line a human's prompt left: no agent's words, no nudge, no reminder.
fn human_prompt(e: &Value, repo: &str) -> bool {
    field(e, "repo") == Some(repo)
        && event(e) == "UserPromptSubmit"
        && field(e, "silent") != Some("not-human")
        && !has(e, "reason")
}

fn kind_of(e: &Value) -> Option<Kind> {
    field(e, "kind").and_then(Kind::from_name)
}

/// The kind a bare continuation takes: that of this session's latest human prompt; with none in
/// the session, that of the repo's latest from another session at most 12 hours before `now`.
pub fn recent_kind(log: &[Value], repo: &str, session: &str, now: i64) -> Option<Kind> {
    if let Some(mine) = log
        .iter()
        .rfind(|e| in_session(e, session) && human_prompt(e, repo))
    {
        return kind_of(mine);
    }
    let mut best = i64::MIN;
    let mut kind = None;
    for e in log {
        if in_session(e, session) || !human_prompt(e, repo) {
            continue;
        }
        let Some(t) = field(e, "ts").and_then(iso::parse) else {
            continue;
        };
        if now - t > WINDOW_MS || t < best {
            continue;
        }
        best = t;
        kind = kind_of(e);
    }
    kind
}
