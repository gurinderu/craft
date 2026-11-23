//! What a run's telemetry is completed with after it was kept: the plugin root whose commit its
//! records are stamped with (`craftCommit`), when the run was started with none known (`start`
//! given no `--craft-root`, the binary under no plugin) or its own was uninstalled — one found
//! later, holding the plugin manifest, is kept for every write after it, a stopped part's still
//! pending included — and the run's identity, for a filing kept before it carried one. A run that
//! knows no root files all the same: the binary writes the store itself.

use std::path::{Path, PathBuf};

use super::kept::{Ctx, load, save};
use crate::prompts::plugin_path;

/// What marks a craft plugin root.
const MANIFEST: &str = ".claude-plugin/plugin.json";

/// The first of `candidates` that is a craft plugin root (holds its manifest): the binary's own
/// plugin root, then the one the harness names (`CLAUDE_PLUGIN_ROOT`).
#[must_use]
pub fn found_root(candidates: impl IntoIterator<Item = Option<PathBuf>>) -> Option<String> {
    candidates
        .into_iter()
        .flatten()
        .filter(|r| !r.as_os_str().is_empty())
        .find(|r| plugin_path(r, MANIFEST).is_file())
        .map(|r| r.display().to_string())
}

/// Completes what the run's telemetry, and each stopped part of it still pending, knows of the
/// run before a write: `root` where it knows none, or one that no longer holds the adapter (an
/// uninstalled copy); the run's identity, read off its state, where it was kept before it had one.
/// A run a newer craft wrote is left as that craft kept it ([`crate::state::newer`]).
pub fn adopt(run: &Path, root: Option<&str>) {
    if crate::state::newer(run) {
        return;
    }
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

/// `ctx` takes `root` unless the root it knows is still a plugin root; whether it did.
fn rooted(ctx: &mut Ctx, root: &str) -> bool {
    let holds = |r: &str| !r.is_empty() && plugin_path(Path::new(r), MANIFEST).is_file();
    if ctx.root.as_deref().is_some_and(holds) || ctx.root.as_deref() == Some(root) {
        return false;
    }
    ctx.root = Some(root.to_owned());
    true
}
