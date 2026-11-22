//! What the `PreToolUse` hook on the Agent tool says when the main session dispatches the repo's
//! own reviewer (realm @nick/craft, node #417; one engine for any language: #420): the repo's
//! reviewer stands, and the same range also goes through craft's review engine in the main
//! session — a subagent has no Workflow tool (#262). The dispatch is never blocked: the context
//! reaches the model after the tool result (#289), which for a background reviewer is at once. The
//! lines are a rule: said once per session and variant until a compact or clear (#288).

use std::path::Path;

use serde_json::Value;

use super::declared::{self, repo_root};
use super::heard::{DISPATCH, dispatch_said};
use super::work::craft_agent;
use super::{Ctx, Harness, Run, context, cwd_of, fields, frontmatter, text_of};

const EVENT: &str = "PreToolUse";

/// The repo's own agent dispatched as `kind` (by its frontmatter name, else its file name): its
/// file and whether it is a reviewer.
fn project_agent(root: &Path, kind: &str) -> Option<(String, bool)> {
    for file in declared::read(root, Harness::ClaudeCode).agents {
        let Ok(bytes) = std::fs::read(root.join(&file)) else {
            continue;
        };
        let (name, description) = frontmatter::read(&String::from_utf8_lossy(&bytes));
        let base = Path::new(&file).file_name().map_or(String::new(), |n| {
            let n = n.to_string_lossy();
            n.strip_suffix(".md")
                .filter(|s| !s.is_empty())
                .unwrap_or(&n)
                .to_owned()
        });
        if (if name.is_empty() { &base } else { &name }) == kind {
            return Some((file, frontmatter::is_reviewer(&name, &description)));
        }
    }
    None
}

/// The lines for a dispatch of the repo's reviewer `kind` (from `file`).
fn said(kind: &str, file: &str, background: bool, ctx: &Ctx) -> String {
    let when = if background {
        "it runs in the background, so launch the engine now, in parallel, not after it returns"
    } else {
        "launch the engine now, on the range the reviewer was given"
    };
    let cli = Path::new(ctx.var("CLAUDE_PLUGIN_ROOT"))
        .join("integrations/shared")
        .join("craft-cli.sh");
    [
        format!(
            "craft: {kind} is this repo's own reviewer ({file}); it and the repo's rules stand. The same diff range also goes through craft's review engine here in the main session (Workflow tool; never a subagent, which has none): the craft:review workflow {{ base: <the same base>, fresh: true, fullEvery: 0 }} on any language (each changed file under its profile, in one run; add delta: true when that range is only the fix commits since an earlier review, so a clean run does not approve), on the branch the reviewer reviews — {when}."
        ),
        "craft: when that branch lives in another checkout or worktree than this session's directory, add repo: \"<that checkout's absolute path>\" to the engine's arguments; without it the engine reviews this directory.".to_owned(),
        format!(
            "craft: when both are back, fold the engine's findings into {kind}'s verdict under the repo's own rules: a Medium-or-higher finding from either side stays open until it is closed. Once the engine run has ended: sh \"{}\" runs enrich-cost --run-id <wf_…> (best-effort).",
            cli.display()
        ),
        "craft: to silence this, set CRAFT_ROLE_HOOK=0 or add a line `craft-role-hook: off` to AGENTS.md or CLAUDE.md.".to_owned(),
    ]
    .join("\n")
}

/// One `PreToolUse` run on the Agent tool. Not logged: another tool, craft's own agents and a type
/// that is no agent of the repo's. Logged, each with `reason: reviewer-dispatch`: the repo test's
/// silence, `not-review`, `in-subagent` (no Workflow tool there), `codex` (none there either),
/// `already-said` (once per session and variant, background or not, until a compact or clear: realm
/// @nick/craft, node #288), or the lines it spoke; those two carry the variant as `background`.
pub fn run(input: &str, ctx: &Ctx) -> Run {
    let fields = fields(input);
    let Some(tool) = fields
        .get("tool_input")
        .filter(|v| v.is_object() || v.is_array())
    else {
        return Run::default();
    };
    let kind = tool
        .get("subagent_type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if text_of(&fields, "tool_name") != "Agent" || kind.is_empty() || craft_agent(kind) {
        return Run::default();
    }
    let cwd = cwd_of(&fields, ctx);
    let Some((file, reviewer)) = project_agent(&repo_root(&cwd), kind) else {
        return Run::default();
    };
    let who = Harness::of(&fields, ctx);
    let mut base = declared::repo_test(&cwd, text_of(&fields, "session_id"), ctx, EVENT, who);
    base.agent = Some(kind.to_owned());
    let base = base.because(DISPATCH);
    let quiet = |why: &str| Run {
        stdout: String::new(),
        entry: Some(base.clone().quiet(why)),
    };
    if !base.spoke {
        return Run {
            stdout: String::new(),
            entry: Some(base),
        };
    }
    if !reviewer {
        return quiet("not-review");
    }
    if !text_of(&fields, "agent_id").is_empty() {
        return quiet("in-subagent");
    }
    if who == Harness::Codex {
        return quiet("codex");
    }
    let background = tool.get("run_in_background") == Some(&Value::Bool(true));
    let mut line = base.clone();
    line.background = Some(background);
    if !line.session.is_empty() && dispatch_said(&ctx.logged(), &line.session, background) {
        return Run {
            stdout: String::new(),
            entry: Some(line.quiet("already-said")),
        };
    }
    Run {
        stdout: context(EVENT, &said(kind, &file, background, ctx)),
        entry: Some(line),
    }
}
