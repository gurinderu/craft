//! What `craft review run` runs with, read from its arguments and the host's environment
//! variables, or why it cannot run: a refusal is answered before anything ran.

use std::num::NonZeroUsize;
use std::path::PathBuf;

use craft_review::prompts::plugin_root_at;
use regex::Regex;

use super::host::Host;
use super::{HostKind, RunArgs, models};
use crate::review::find_craft_root;

/// The host's own environment variable for `what`.
fn host_env(kind: HostKind, what: &str) -> Option<String> {
    let host = match kind {
        HostKind::Codex => "CODEX",
        HostKind::Pi => "PI",
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

/// The host from the arguments, or why it cannot be used.
pub(super) fn host_of(args: &RunArgs) -> Result<Host, String> {
    let (name, command) = match args.backend {
        HostKind::Codex => (r"^[\w.:/-]{1,80}$", "codex"),
        HostKind::Pi => (r"^[\w.:/@*-]{1,120}$", "pi"),
    };
    let name = Regex::new(name).map_err(|e| e.to_string())?;
    let spec = args
        .models
        .clone()
        .or_else(|| host_env(args.backend, "MODELS"))
        .unwrap_or_default();
    let command = args
        .host_bin
        .clone()
        .or_else(|| host_env(args.backend, "BIN").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(command));
    Ok(Host {
        kind: args.backend,
        models: models::model_table(&spec, &name)?,
        command,
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
