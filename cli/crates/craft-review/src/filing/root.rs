//! The plugin root a run's telemetry is filed through when the run was started with none known
//! (`start` given no `--craft-root`, the binary under no plugin): one found later, holding the
//! adapter, is kept for every write after it — a stopped part's still pending included.

use std::path::{Path, PathBuf};

use super::kept::{load, save};
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

/// The run's telemetry, and each stopped part of it still pending, takes `root` where it knows
/// none; a root it knows is kept.
pub fn adopt_root(run: &Path, root: &str) {
    let Some(mut filing) = load(run) else {
        return;
    };
    let mut adopted = false;
    for ctx in std::iter::once(&mut filing.ctx).chain(filing.pending.iter_mut().map(|p| &mut p.ctx))
    {
        if ctx.root.as_deref().is_none_or(str::is_empty) {
            ctx.root = Some(root.to_owned());
            adopted = true;
        }
    }
    if adopted {
        // A state it cannot keep is said by the next write's own save.
        save(run, &filing, &mut Vec::new());
    }
}
