//! What `craft review run` runs with, read from its arguments and the host's environment
//! variables, or why it cannot run: a refusal is answered before anything ran.

use std::num::NonZeroUsize;
use std::path::PathBuf;

use craft_review::prompts::plugin_root_at;
use regex::Regex;

use super::host::Host;
use super::models::ThinkingTable;
use super::{HostKind, RunArgs, models};
use crate::review::find_craft_root;

/// The host's own environment variable for `what`.
fn host_env(kind: HostKind, what: &str) -> Option<String> {
    let host = match kind {
        HostKind::Codex => "CODEX",
        HostKind::Pi => "PI",
        HostKind::OpenCode => "OPENCODE",
    };
    std::env::var(format!("CRAFT_{host}_{what}")).ok()
}

/// The concurrency asked for, or why it cannot be used.
pub(super) fn concurrency_of(args: &RunArgs) -> Result<NonZeroUsize, String> {
    let given = match (args.concurrency, host_env(args.backend, "CONCURRENCY")) {
        (Some(n), _) => Some(n),
        (None, Some(t)) => Some(
            t.trim()
                .parse::<u8>()
                .ok()
                .filter(|n| (1..=16).contains(n))
                .ok_or_else(|| format!("concurrency {t:?} is not a whole number from 1 to 16"))?,
        ),
        (None, None) => None,
    };
    Ok(NonZeroUsize::new(usize::from(given.unwrap_or(4))).unwrap_or(NonZeroUsize::MIN))
}

/// The host from the arguments and its environment variables, or why it cannot be used.
pub(super) fn host_of(args: &RunArgs) -> Result<Host, String> {
    host_with(args, &|what| host_env(args.backend, what))
}

/// pi's thinking level for each tier from `--thinking`, else `CRAFT_PI_THINKING` (realm
/// `@nick/craft`, node #518); another host takes none, and is refused one.
fn thinking_of(
    args: &RunArgs,
    env: &dyn Fn(&str) -> Option<String>,
) -> Result<ThinkingTable, String> {
    match (args.backend, &args.thinking) {
        (HostKind::Pi, flag) => {
            models::thinking_table(&flag.clone().or_else(|| env("THINKING")).unwrap_or_default())
        }
        (_, Some(_)) => {
            Err("--thinking is pi's alone: this backend takes no thinking level".into())
        }
        (_, None) => Ok(ThinkingTable::new()),
    }
}

/// The host from the arguments and `env`, the host's variable for a name, or why it cannot be
/// used.
fn host_with(args: &RunArgs, env: &dyn Fn(&str) -> Option<String>) -> Result<Host, String> {
    let (name, command) = match args.backend {
        HostKind::Codex => (r"^[\w.:/-]{1,80}$", "codex"),
        HostKind::Pi => (r"^[\w.:/@*-]{1,120}$", "pi"),
        // `provider/model`, a `#variant` allowed (opencode 2.x).
        HostKind::OpenCode => (r"^[\w.@-]{1,60}/[\w.:/@#-]{1,120}$", "opencode"),
    };
    let name = Regex::new(name).map_err(|e| e.to_string())?;
    let spec = args
        .models
        .clone()
        .or_else(|| env("MODELS"))
        .unwrap_or_default();
    let command = args
        .host_bin
        .clone()
        .or_else(|| env("BIN").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(command));
    Ok(Host {
        kind: args.backend,
        models: models::model_table(&spec, &name)?,
        thinking: thinking_of(args, env)?,
        command,
        agents: None,
        archived: true,
    })
}

/// The plugin root the tasks read craft's agents and skills from, and the run is filed through.
pub(super) fn root_of(args: &RunArgs) -> Result<PathBuf, String> {
    let given = args.start.craft_root.as_deref().map(std::path::absolute);
    let near = match given {
        Some(Ok(p)) => plugin_root_at(&p),
        Some(Err(e)) => return Err(format!("--craft-root cannot be resolved: {e}")),
        None => find_craft_root(),
    };
    near.ok_or_else(|| "no craft plugin root is known: pass --craft-root <the plugin's directory or a craft checkout>".into())
}

#[cfg(test)]
#[path = "args_tests.rs"]
mod tests;
