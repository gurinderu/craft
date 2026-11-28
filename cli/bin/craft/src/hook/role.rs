//! craft's hooks on a session's roles and work rules, as this binary (realm @nick/craft, node #538;
//! in the binary, not Node: #537): `craft hook session-start` (what the session hears at its start,
//! node #275), `user-prompt` and `subagent-start` (at the moment of work and to the subagent it is
//! handed to, #288), `reviewer-dispatch` (when the main session dispatches the repo's own
//! reviewer, #417). Each reads the harness's hook input, prints the JSON that adds its lines as
//! context or nothing, and appends its trace to `~/.craft/hooks.jsonl` (#281). The same input
//! gives the same output as the Node hooks they replace, which `content/parity/hook-cases.json`
//! holds. None of them ever fails a session: what goes wrong inside is silence (#276).

mod declared;
mod dispatch;
mod entry;
mod feedback;
mod frontmatter;
mod heard;
mod iso;
mod js;
mod key;
mod kind;
mod opencode;
mod readiness;
mod remind;
mod retro;
mod retro_offered;
mod start;
mod text;
mod text_codex;
mod text_opencode;
mod word;
mod work;

#[cfg(test)]
mod parity;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

pub use entry::{Entry, append, log_path};

/// What one hook run is given besides its input: the environment it reads, where `~/.craft`
/// lives, the directory a missing `cwd` falls back to, and the time it stamps its line with.
pub struct Ctx {
    pub env: HashMap<String, String>,
    pub home: Option<PathBuf>,
    pub fallback_cwd: PathBuf,
    /// Milliseconds since the epoch.
    pub now: i64,
}

impl Ctx {
    fn var(&self, key: &str) -> &str {
        self.env.get(key).map_or("", String::as_str)
    }

    fn log(&self) -> Option<PathBuf> {
        self.home.as_deref().map(log_path)
    }

    /// The hook log's lines, read only when a decision needs them.
    fn logged(&self) -> Vec<Value> {
        self.log()
            .map(|f| entry::read(&f).unwrap_or_default())
            .unwrap_or_default()
    }
}

/// One run's output: `stdout` empty for silence, `entry` the line for the hook log or none.
#[derive(Debug, Default)]
pub struct Run {
    pub stdout: String,
    pub entry: Option<Entry>,
}

/// Which hook runs.
#[derive(Debug, Clone, Copy)]
pub enum Hook {
    SessionStart,
    UserPrompt,
    SubagentStart,
    ReviewerDispatch,
    OpencodeMessage,
    OpencodeCompacted,
}

/// One run of `hook` over the harness's input.
pub fn run(hook: Hook, input: &str, ctx: &Ctx) -> Run {
    match hook {
        Hook::SessionStart => start::run(input, ctx, &readiness::Spawned),
        Hook::UserPrompt => work::prompt(input, ctx),
        Hook::SubagentStart => work::subagent(input, ctx),
        Hook::ReviewerDispatch => dispatch::run(input, ctx),
        Hook::OpencodeMessage => opencode::message(input, ctx),
        Hook::OpencodeCompacted => opencode::compacted(input, ctx),
    }
}

/// Which harness runs the hook: Codex puts `turn_id` in its prompt and subagent inputs and gives a
/// hook command `PLUGIN_ROOT` beside `CLAUDE_PLUGIN_ROOT`; Claude Code does neither (#293).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Harness {
    ClaudeCode,
    Codex,
    /// The OpenCode plugin, which names itself by the subcommand it runs.
    OpenCode,
}

impl Harness {
    fn of(fields: &Map<String, Value>, ctx: &Ctx) -> Self {
        if !text_of(fields, "turn_id").is_empty() || !ctx.var("PLUGIN_ROOT").is_empty() {
            Self::Codex
        } else {
            Self::ClaudeCode
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
        }
    }
}

/// The input's fields; none when it is not a JSON object.
fn fields(input: &str) -> Map<String, Value> {
    match serde_json::from_str(input) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// A string field, `""` when absent or of another type.
fn text_of<'a>(fields: &'a Map<String, Value>, key: &str) -> &'a str {
    fields.get(key).and_then(Value::as_str).unwrap_or("")
}

/// The input's `cwd`, else the fallback.
fn cwd_of(fields: &Map<String, Value>, ctx: &Ctx) -> PathBuf {
    let cwd = text_of(fields, "cwd");
    if cwd.is_empty() {
        ctx.fallback_cwd.clone()
    } else {
        Path::new(cwd).to_path_buf()
    }
}

/// The hook output that adds `text` as context to `event`.
fn context(event: &str, text: &str) -> String {
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Specific<'a> {
        hook_event_name: &'a str,
        additional_context: &'a str,
    }
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Out<'a> {
        hook_specific_output: Specific<'a>,
    }
    serde_json::to_string(&Out {
        hook_specific_output: Specific {
            hook_event_name: event,
            additional_context: text,
        },
    })
    .unwrap_or_default()
}
