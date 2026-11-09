//! What a run's telemetry is completed with after it was kept: the plugin root it is filed through,
//! when the run was started with none known (`start` given no `--craft-root`, the binary under no
//! plugin) or its own was uninstalled — one found later, holding the adapter, is kept for every
//! write after it, a stopped part's still pending included — and the run's identity, for a filing
//! kept before it carried one.

use std::path::{Path, PathBuf};

use super::kept::{Ctx, load, save};
use super::node::ADAPTER;

/// The first of `candidates` that holds the adapter: the binary's own plugin root, then the one the
/// harness names (`CLAUDE_PLUGIN_ROOT`).
#[must_use]
pub fn found_root(candidates: impl IntoIterator<Item = Option<PathBuf>>) -> Option<String> {
    candidates
        .into_iter()
        .flatten()
        .filter(|r| !r.as_os_str().is_empty())
        .find(|r| r.join(ADAPTER).is_file())
        .map(|r| r.display().to_string())
}

/// Completes what the run's telemetry, and each stopped part of it still pending, knows of the
/// run before a write: `root` where it knows none, or one that no longer holds the adapter (an
/// uninstalled copy); the run's identity, read off its state, where it was kept before it had one.
pub fn adopt(run: &Path, root: Option<&str>) {
    let Some(mut filing) = load(run) else {
        return;
    };
    let state = crate::state::load(run).ok();
    let mut changed = false;
    for ctx in std::iter::once(&mut filing.ctx).chain(filing.pending.iter_mut().map(|p| &mut p.ctx))
    {
        changed |= root.is_some_and(|r| rooted(ctx, r));
        if let Some(state) = state.as_ref().filter(|_| ctx.git_dir.is_empty()) {
            *ctx = std::mem::take(ctx).known_as(state);
            changed |= !ctx.git_dir.is_empty();
        }
    }
    if changed {
        // A state it cannot keep is said by the next write's own save.
        save(run, &filing, &mut Vec::new());
    }
}

/// `ctx` takes `root` unless the root it knows still holds the adapter; whether it did.
fn rooted(ctx: &mut Ctx, root: &str) -> bool {
    let holds = |r: &str| !r.is_empty() && Path::new(r).join(ADAPTER).is_file();
    if ctx.root.as_deref().is_some_and(holds) || ctx.root.as_deref() == Some(root) {
        return false;
    }
    ctx.root = Some(root.to_owned());
    true
}
