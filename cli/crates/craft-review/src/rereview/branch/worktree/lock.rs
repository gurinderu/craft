//! The lock that serializes laying craft's worktree of one PR head: runs on several hosts start at
//! once, and only one may add the worktree while the others wait and then reuse it — else the
//! loser's `worktree add` fails, or it reads the half-made tree as dirty.

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// How long a start waits for another run laying the same worktree: past a fetch's own bound.
const WAIT: Duration = Duration::from_secs(300);
/// A lock older than this is a run that died while laying, and is taken over.
const STALE: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_millis(100);

/// `<dir>.lock`, held while the worktree at `dir` is looked at and laid; removed when dropped.
pub(super) struct Lock(PathBuf);

impl Lock {
    /// The lock of the worktree at `dir`, waiting for another run to release it.
    ///
    /// # Errors
    /// When it cannot be created, or another run held it past [`WAIT`].
    pub(super) fn take(dir: &Path) -> Result<Self, String> {
        let mut path = dir.as_os_str().to_owned();
        path.push(".lock");
        let path = PathBuf::from(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("creating {}: {e}", parent.display()))?;
        }
        let began = SystemTime::now();
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(Self(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(format!("taking {}: {e}", path.display())),
            }
            if stale(&path) {
                // Another waiter may take it over first; the next create_new decides.
                let _gone = std::fs::remove_file(&path);
                continue;
            }
            if began.elapsed().unwrap_or_default() > WAIT {
                return Err(format!(
                    "another run has been laying this worktree for over {}s ({} is held)",
                    WAIT.as_secs(),
                    path.display()
                ));
            }
            std::thread::sleep(POLL);
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _gone = std::fs::remove_file(&self.0);
    }
}

/// Whether the lock at `path` was made over [`STALE`] ago.
fn stale(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age > STALE)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lock_left_by_a_dead_run_is_taken_over_and_a_released_one_is_gone() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("key").join("pr-7-abc");
        std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
        let left = std::fs::File::create(dir.with_extension("lock")).unwrap();
        left.set_modified(SystemTime::now() - STALE * 2).unwrap();
        let held = Lock::take(&dir).unwrap();
        assert!(held.0.exists());
        drop(held);
        assert!(!dir.with_extension("lock").exists());
    }
}
