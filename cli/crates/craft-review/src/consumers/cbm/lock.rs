//! One review at a time indexes a project (realm @nick/craft, node #530): a lock directory per
//! project, `<locks>/<project>.lock`, its holder's token in `owner`, as `lib/craft-fetch.sh` locks
//! a download. A second review waits for it within its deadline; a lock older than [`STALE`] is a
//! dead holder's and is taken over; a holder removes the lock only while it is still its own. The
//! index run itself removes it when it exits, so an index left running past a review's budget
//! keeps it until it ends.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use super::CbmError;
use crate::cancel::Cancel;

/// The age past which a lock is a dead holder's.
const STALE: Duration = Duration::from_secs(600);
/// How often a held lock is looked at again.
const POLL: Duration = Duration::from_millis(100);

/// Where a review keeps its index locks: `~/.craft/cbm-locks`, shared by every craft on the
/// machine; the scratch directory's when there is no home.
#[must_use]
pub fn review_locks() -> PathBuf {
    craft_store::read::home().map_or_else(scratch_locks, |h| h.join(".craft").join("cbm-locks"))
}

/// The index locks of a list built outside a review (tests, a library caller): under the
/// temporary directory.
#[must_use]
pub fn scratch_locks() -> PathBuf {
    std::env::temp_dir().join("craft-cbm-locks")
}

/// A lock this run holds: its directory and the token in its `owner`.
#[derive(Debug)]
pub(super) struct Lock {
    pub(super) dir: PathBuf,
    pub(super) token: String,
}

/// Takes the lock of `project` under `locks`, waiting for another holder until `deadline`.
///
/// # Errors
/// [`CbmError::Locked`] when another holds it past `deadline`, [`CbmError::Stopped`] once
/// `cancel` is, [`CbmError::Output`] when the lock cannot be made.
pub(super) fn take(
    locks: &Path,
    project: &str,
    deadline: Instant,
    cancel: &Cancel,
) -> Result<Lock, CbmError> {
    let failed = |e: std::io::Error| CbmError::Output(format!("the index lock of {project}: {e}"));
    std::fs::create_dir_all(locks).map_err(failed)?;
    let dir = locks.join(format!("{project}.lock"));
    loop {
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                let token = token();
                std::fs::write(dir.join("owner"), &token).map_err(failed)?;
                return Ok(Lock { dir, token });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(failed(e)),
        }
        if stale(&dir) {
            std::fs::remove_dir_all(&dir).unwrap_or(());
            continue;
        }
        if cancel.is_cancelled() {
            return Err(CbmError::Stopped);
        }
        if Instant::now() >= deadline {
            return Err(CbmError::Locked {
                project: project.to_owned(),
                lock: dir.display().to_string(),
            });
        }
        std::thread::sleep(POLL);
    }
}

impl Lock {
    /// Removes the lock while it is still this run's.
    pub(super) fn release(&self) {
        let owner = std::fs::read_to_string(self.dir.join("owner")).unwrap_or_default();
        if owner == self.token {
            std::fs::remove_dir_all(&self.dir).unwrap_or(());
        }
    }
}

/// Whether the lock at `dir` was made longer than [`STALE`] ago.
fn stale(dir: &Path) -> bool {
    std::fs::metadata(dir)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age > STALE)
}

/// A token no other holder has: this process and the time.
fn token() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("{}-{nanos}", std::process::id())
}
