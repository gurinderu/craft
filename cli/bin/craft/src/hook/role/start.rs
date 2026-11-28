//! What the `SessionStart` hook says, and when (realm @nick/craft, node #275; the risk it is held
//! against, #276): in a repo that declares its own roles or work rules, that they win on every
//! step they cover (#264) and the cycle craft's tools run (#266; a subagent has no Workflow tool,
//! #262); under Codex its own cycle lines (#293) and what the session must know before a review
//! (`super::readiness`); in any repository whose review runs call for one, the offer of a retro
//! (`super::retro`).

use super::declared::{self, SWITCH_ENV};
use super::readiness::{self, Probe};
use super::retro;
use super::{Ctx, Harness, Run, context, cwd_of, fields, text_codex, text_of};

const EVENT: &str = "SessionStart";
const NAMES_SHOWN: usize = 4;

fn name_list(names: &[String]) -> String {
    let shown = names
        .iter()
        .take(NAMES_SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > NAMES_SHOWN {
        format!("{shown} and {} more", names.len() - NAMES_SHOWN)
    } else {
        shown
    }
}

fn cycle(who: Harness) -> [String; 2] {
    match who {
        Harness::ClaudeCode | Harness::OpenCode => [
            "craft: whichever declared role develops here runs its cycle with craft's tools: recall project memory (craft:memory) before the work; before a PR, the review loop to convergence and one full review (craft:develop).".to_owned(),
            "craft: only the main session can run craft's workflow engines (a session started with --agent counts if its tools allow Workflow); a role running as a subagent hands the review loop back to the main session.".to_owned(),
        ],
        Harness::Codex => text_codex::cycle(),
    }
}

/// The role text for what the repo declares.
fn role_text(found: &[String], who: Harness) -> String {
    let mut lines = vec![format!(
        "craft: this repo declares its own roles or work rules ({}); they win on every step they cover, except the final full review, where they run beside craft's full review and never replace it.",
        name_list(found)
    )];
    lines.extend(cycle(who));
    lines.push(format!(
        "craft: to silence this, set {SWITCH_ENV}=0 or add a line `craft-role-hook: off` to AGENTS.md or CLAUDE.md."
    ));
    lines.join("\n")
}

/// One `SessionStart` run: the role text where the repo declares a role, and under Codex the
/// readiness lines after it unless the hook is switched off. A run that said only the readiness
/// lines is logged as one that spoke, with `reason: codex-readiness`; one that said only the retro
/// offer, with `reason: retro-offer`.
pub fn run(input: &str, ctx: &Ctx, probe: &dyn Probe) -> Run {
    let fields = fields(input);
    let cwd = cwd_of(&fields, ctx);
    let who = Harness::of(&fields, ctx);
    let mut entry = declared::repo_test(&cwd, text_of(&fields, "session_id"), ctx, EVENT, who);
    text_of(&fields, "source").clone_into(&mut entry.source);
    let mut text = if entry.spoke {
        role_text(&entry.found, who)
    } else {
        String::new()
    };
    let off = matches!(entry.silent.as_deref(), Some("off-env" | "off-line"));
    if who == Harness::Codex && !off {
        let lines = readiness::lines(probe);
        if !lines.is_empty() {
            let mut all: Vec<&str> = vec![&text];
            all.extend(lines.iter().map(|(_, t)| t.as_str()));
            text = all
                .into_iter()
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            let reason = !entry.spoke;
            entry.spoke = true;
            entry.silent = None;
            entry.readiness = Some(lines.iter().map(|(n, _)| (*n).to_owned()).collect());
            if reason {
                entry = entry.because("codex-readiness");
            }
        }
    }
    if let Some(offer) = retro::offer(ctx, &entry.repo, env!("CARGO_PKG_VERSION")) {
        if !entry.spoke {
            entry.spoke = true;
            entry.silent = None;
            entry = entry.because("retro-offer");
        }
        text = if text.is_empty() {
            offer
        } else {
            format!("{text}\n{offer}")
        };
    }
    let stdout = if text.is_empty() {
        String::new()
    } else {
        context(EVENT, &text)
    };
    Run {
        stdout,
        entry: Some(entry),
    }
}
