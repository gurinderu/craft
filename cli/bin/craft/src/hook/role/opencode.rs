//! The work hook in OpenCode (realm @nick/craft, nodes #288, #550): `craft hook opencode-message`
//! and `opencode-compacted`, which the OpenCode plugin (integrations/opencode/plugin/work-hook.ts)
//! runs on each user message and compaction. The same request classes, repo test, off switch and
//! hook log as the Claude Code hooks, over what OpenCode's plugin API gives: a message's `prompt`,
//! `session` and `cwd`; on a subagent session's first message its `parent` and `agent`; and
//! `placeable`, whether the plugin has somewhere to put the lines. It prints the lines to add, or
//! nothing, and logs each decision as `chat.message` (a compaction as `session.compacted`).

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use super::entry::{event, field, has};
use super::heard::said_in_session;
use super::js::{Re, compile};
use super::kind::prompt_kind;
use super::remind::{REMINDER, hushed, repeat_of};
use super::work::craft_agent;
use super::{Ctx, Harness, Run, cwd_of, declared, fields, text_of, text_opencode};

const EVENT: &str = "chat.message";
// An Iskron wake-up delivered as a user message: no human's word.
static WAKE: Re = Re::new(|| compile(r"(?i)^[{S}]*\[iskron\]"));

/// A main session's message: silent and unlogged on a prompt of no class or an Iskron wake-up;
/// otherwise the text of its class, once per class and session until a compaction, the reminder
/// for a later prompt in another script beside a sign of PR or review work.
fn main_message(prompt: &str, session: &str, cwd: &Path, ctx: &Ctx) -> Run {
    if WAKE.is_match(prompt) {
        return Run::default();
    }
    let Some(kind) = prompt_kind(prompt, None) else {
        return Run::default();
    };
    let base = declared::repo_test(cwd, session, ctx, EVENT, Harness::OpenCode);
    let mut entry = base.clone();
    entry.kind = Some(kind.name().to_owned());
    let repeat = if entry.spoke {
        repeat_of(&ctx.logged(), session, false, kind, prompt, ctx.now)
    } else {
        None
    };
    if repeat == Some(REMINDER) {
        return Run {
            stdout: text_opencode::reminder(),
            entry: Some(base.because(REMINDER)),
        };
    }
    if let Some(why) = repeat {
        entry = hushed(entry, why);
    }
    Run {
        stdout: if entry.spoke {
            text_opencode::prompt(kind)
        } else {
            String::new()
        },
        entry: Some(entry),
    }
}

/// A subagent's first message: it speaks in a repo where the start hook would, when the brief asks
/// for review work or its parent heard the prompt lines, never to craft's own agents (unlogged);
/// logged under the parent session with the agent.
fn subagent_message(prompt: &str, parent: &str, agent: &str, cwd: &Path, ctx: &Ctx) -> Run {
    if craft_agent(agent) {
        return Run::default();
    }
    let kind = prompt_kind(prompt, None);
    let mut entry = declared::repo_test(cwd, parent, ctx, EVENT, Harness::OpenCode);
    entry.agent = Some(agent.to_owned());
    entry.agent_kind = kind.map(|k| k.name().to_owned());
    let heard = |e: &Value| {
        event(e) == EVENT
            && field(e, "session") == Some(parent)
            && !has(e, "agent")
            && e.get("spoke").and_then(Value::as_bool) == Some(true)
    };
    if !entry.spoke || kind.is_none() && !ctx.logged().iter().any(heard) {
        return Run::default();
    }
    Run {
        stdout: text_opencode::subagent(),
        entry: Some(entry),
    }
}

/// One OpenCode user message; a line said with no part to put it on is logged as `no-part`.
pub fn message(input: &str, ctx: &Ctx) -> Run {
    let fields = fields(input);
    let (prompt, session) = (text_of(&fields, "prompt"), text_of(&fields, "session"));
    let cwd = cwd_of(&fields, ctx);
    let parent = text_of(&fields, "parent");
    let mut run = if parent.is_empty() {
        main_message(prompt, session, &cwd, ctx)
    } else {
        subagent_message(prompt, parent, text_of(&fields, "agent"), &cwd, ctx)
    };
    let placeable = fields.get("placeable").and_then(Value::as_bool) != Some(false);
    if !placeable && !run.stdout.is_empty() {
        run.entry = run.entry.map(|e| e.quiet("no-part"));
    }
    run
}

/// A session's compaction: the line that lets the prompt lines be said again, logged only for a
/// session where they were said. The off switch is not read: the line only resets.
pub fn compacted(input: &str, ctx: &Ctx) -> Run {
    let fields = fields(input);
    let session = text_of(&fields, "session");
    if !said_in_session(&ctx.logged(), session, None) {
        return Run::default();
    }
    let bare = Ctx {
        env: HashMap::new(),
        home: None,
        fallback_cwd: ctx.fallback_cwd.clone(),
        now: ctx.now,
    };
    let mut entry = declared::repo_test(
        &cwd_of(&fields, ctx),
        session,
        &bare,
        "session.compacted",
        Harness::OpenCode,
    );
    "compact".clone_into(&mut entry.source);
    entry.spoke = false;
    entry.found.clear();
    entry.silent = Some("context-reset".to_owned());
    Run {
        stdout: String::new(),
        entry: Some(entry),
    }
}
