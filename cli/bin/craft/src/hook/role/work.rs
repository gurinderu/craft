//! What the hook says at the moment of work and to the subagent the work is handed to (realm
//! @nick/craft, node #288; the counter-example it answers, #287): lines at session start reach
//! neither the moment the human asks for review work nor a subagent's brief. Same repo test and
//! off switch as the start hook (#275, #264); the words follow the harness (#293).

use serde_json::{Map, Value};

use super::entry::{Entry, event, field};
use super::heard::{NUDGE, REMINDER, nudged_in_session, recent_kind, repeat_of, said_in_session};
use super::kind::{Kind, prompt_kind};
use super::word::{continuation, not_human, subagent_report};
use super::{Ctx, Harness, Run, context, cwd_of, declared, fields, text, text_codex, text_of};

// The Workflow tool's own agents start as this type: they are the loop.
const ENGINE_AGENT: &str = "workflow-subagent";
// craft's shipped agents by the names a delivery without a plugin namespace gives them.
const CRAFT_AGENTS: [&str; 7] = [
    "engine-service",
    "nix-reviewer",
    "review-task",
    "rust-architecture-reviewer",
    "rust-miri",
    "rust-reviewer",
    "rust-security-scanner",
];

/// An agent whose brief craft itself writes (an engine's lens, a skill's dispatch).
pub fn craft_agent(agent: &str) -> bool {
    agent.starts_with("craft:") || CRAFT_AGENTS.contains(&agent) || agent == ENGINE_AGENT
}

fn decide(fields: &Map<String, Value>, ctx: &Ctx, event: &str) -> (Entry, Harness) {
    let who = Harness::of(fields, ctx);
    let cwd = cwd_of(fields, ctx);
    (
        declared::repo_test(&cwd, text_of(fields, "session_id"), ctx, event, who),
        who,
    )
}

/// An agent's words the harness delivers as a prompt: the first subagent report in a session's
/// context that heard the findings text (or the conditional one) gets one conditional line;
/// anything else is a silence logged as `not-human`. A silent repo logs nothing.
fn on_agent_words(prompt: &str, entry: Entry, who: Harness, ctx: &Ctx) -> Run {
    if !entry.spoke {
        return Run::default();
    }
    let session = entry.session.clone();
    let log = if subagent_report(prompt) && !session.is_empty() {
        ctx.logged()
    } else {
        Vec::new()
    };
    if said_in_session(&log, &session, Some(&["findings", "other-language"]))
        && !nudged_in_session(&log, &session)
    {
        return Run {
            stdout: context("UserPromptSubmit", &text::nudge(who == Harness::Codex)),
            entry: Some(entry.because(NUDGE)),
        };
    }
    Run {
        stdout: String::new(),
        entry: Some(entry.quiet("not-human")),
    }
}

fn work_text(who: Harness, kind: Kind) -> String {
    match who {
        Harness::Codex => text_codex::prompt(kind == Kind::OtherLanguage),
        Harness::ClaudeCode => text::prompt(kind),
    }
}

/// A `UserPromptSubmit` run: the repo test; a prompt of no class is a silence logged as `no-kind`,
/// an agent's words `not-human`; the text of a class is said once per session until a compact or
/// clear, and a later prompt in another script hears one reminder line.
pub fn prompt(input: &str, ctx: &Ctx) -> Run {
    const EVENT: &str = "UserPromptSubmit";
    let fields = fields(input);
    // Codex also fires it inside a subagent, under the parent's session: SubagentStart spoke there.
    if text_of(&fields, "hook_event_name") != EVENT || !text_of(&fields, "agent_id").is_empty() {
        return Run::default();
    }
    let prompt = text_of(&fields, "prompt");
    let (base, who) = decide(&fields, ctx, EVENT);
    if not_human(prompt) {
        return on_agent_words(prompt, base, who, ctx);
    }
    let recent = if continuation(prompt) {
        recent_kind(&ctx.logged(), &base.repo, &base.session, ctx.now)
    } else {
        None
    };
    let Some(kind) = prompt_kind(prompt, recent) else {
        return Run {
            stdout: String::new(),
            entry: base.spoke.then(|| base.quiet("no-kind")),
        };
    };
    let mut entry = base.clone();
    entry.kind = Some(kind.name().to_owned());
    let repeat = if entry.spoke && !entry.session.is_empty() {
        repeat_of(&ctx.logged(), &entry.session, who == Harness::Codex, kind)
    } else {
        None
    };
    if repeat == Some(REMINDER) {
        let line = match who {
            Harness::Codex => text_codex::reminder(),
            Harness::ClaudeCode => text::reminder(),
        };
        return Run {
            stdout: context(EVENT, &line),
            entry: Some(base.because(REMINDER)),
        };
    }
    if let Some(why) = repeat {
        entry = entry.quiet(why);
    }
    Run {
        stdout: if entry.spoke {
            context(EVENT, &work_text(who, kind))
        } else {
            String::new()
        },
        entry: Some(entry),
    }
}

/// A `SubagentStart` run: it speaks to the subagent only in a repo where the start hook would, in
/// a session where the prompt hook spoke, and never to craft's own agents (not logged: a review
/// run starts dozens of them).
pub fn subagent(input: &str, ctx: &Ctx) -> Run {
    const EVENT: &str = "SubagentStart";
    let fields = fields(input);
    let agent = text_of(&fields, "agent_type");
    let session = text_of(&fields, "session_id");
    if text_of(&fields, "hook_event_name") != EVENT || craft_agent(agent) || session.is_empty() {
        return Run::default();
    }
    let (mut entry, who) = decide(&fields, ctx, EVENT);
    entry.agent = Some(agent.to_owned());
    let heard = |e: &Value| {
        event(e) == "UserPromptSubmit"
            && field(e, "session") == Some(session)
            && e.get("spoke").and_then(Value::as_bool) == Some(true)
    };
    if !entry.spoke || !ctx.logged().iter().any(heard) {
        return Run::default();
    }
    let said = match who {
        Harness::Codex => text_codex::subagent(),
        Harness::ClaudeCode => text::subagent(),
    };
    Run {
        stdout: context(EVENT, &said),
        entry: Some(entry),
    }
}

#[cfg(test)]
#[path = "work_tests.rs"]
mod tests;
