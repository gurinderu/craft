//! The reviewed checkout's `Cargo.lock` kept as it was. clippy runs without `--locked`, as the
//! engine's gate runs it, so a branch that edited a `Cargo.toml` or a crate that commits no lockfile
//! still builds — and cargo may then write the lockfile; the review reads the branch, it never edits
//! it, so each lockfile cargo could write is put back as it was, or removed when there was none,
//! however the run ended (killed by the budget included).

use std::path::{Path, PathBuf};

/// The lockfiles a run on one package may write, as they were before it; put back when dropped.
pub(super) struct Lockfiles {
    /// Each lockfile's path and its bytes before the run, `None` when there was none.
    saved: Vec<(PathBuf, Option<Vec<u8>>)>,
}

impl Lockfiles {
    /// Every `Cargo.lock` beside `manifest` and above it up to `top`, where cargo writes the one of
    /// its workspace's root. One it cannot read is left out: it is never touched.
    pub(super) fn keep(top: &Path, manifest: &str) -> Self {
        let package = top.join(manifest);
        let saved = package
            .parent()
            .into_iter()
            .flat_map(Path::ancestors)
            .take_while(|d| d.starts_with(top))
            .filter_map(|d| {
                let path = d.join("Cargo.lock");
                match std::fs::read(&path) {
                    Ok(bytes) => Some((path, Some(bytes))),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some((path, None)),
                    Err(_) => None,
                }
            })
            .collect();
        Self { saved }
    }
}

impl Drop for Lockfiles {
    fn drop(&mut self) {
        for (path, before) in &self.saved {
            let now = std::fs::read(path).ok();
            if now == *before {
                continue;
            }
            // Best effort: a lockfile that cannot be put back stays as cargo left it.
            match before {
                Some(bytes) => std::fs::write(path, bytes).unwrap_or(()),
                None => std::fs::remove_file(path).unwrap_or(()),
            }
        }
    }
}
