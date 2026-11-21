//! One review at a time indexes a project (realm @nick/craft, node #530): a lock directory per
//! project, `<locks>/<project>.lock`, its holder's token in `owner`, as `lib/craft-fetch.sh` locks
//! a download. A second review waits for it within its deadline; a lock untouched for [`STALE`] is
//! a dead holder's and is taken over, moved aside first; a holder removes the lock only while it
//! is still its own. The index run itself touches it every [`HEARTBEAT`] and removes it when it
//! exits, so an index left running past a review's budget keeps it until it ends.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use super::CbmError;
use crate::cancel::Cancel;

/// The silence past which a lock is a dead holder's.
pub(super) const STALE: Duration = Duration::from_secs(600);
/// How often a running index touches its lock.
pub(super) const HEARTBEAT: Duration = Duration::from_secs(60);
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
    (locks, stale_after): (&Path, Duration),
    project: &str,
    deadline: Instant,
    cancel: &Cancel,
) -> Result<Lock, CbmError> {
    let failed = |e: std::io::Error| CbmError::Output(format!("the index lock of {project}: {e}"));
    std::fs::create_dir_all(locks).map_err(failed)?;
    let dir = locks.join(format!("{project}.lock"));
    loop {
        if let Some(lock) = made(locks, &dir).map_err(failed)? {
            return Ok(lock);
        }
        // Its owner is read before its age, so the lock moved aside is the one found stale.
        let found = std::fs::read_to_string(dir.join("owner")).unwrap_or_default();
        if stale(&dir, stale_after) && set_aside(&dir, &found) {
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

/// The lock at `dir`, made whole with its owner in a directory of this run's own and renamed into
/// place, so no lock is ever seen without its owner; `None` when another holds it.
fn made(locks: &Path, dir: &Path) -> std::io::Result<Option<Lock>> {
    let token = token();
    let new = locks.join(format!(".new-{token}"));
    std::fs::create_dir(&new)?;
    std::fs::write(new.join("owner"), &token)?;
    // A rename onto a lock holding its owner fails: the directory is not empty.
    if std::fs::rename(&new, dir).is_ok() {
        return Ok(Some(Lock {
            dir: dir.to_path_buf(),
            token,
        }));
    }
    std::fs::remove_dir_all(&new).unwrap_or(());
    Ok(None)
}

/// Moves the dead holder's lock at `dir`, owned by `found`, aside under a name of this run's own,
/// an atomic step, and removes it; whether it was moved. A rename that fails is another taker's
/// win: it waits again. A lock moved that is not `found`'s, one another taker made in between, is
/// put back; if a third made one in that instant, two hold it, and the graph refuses the second
/// index of other options (realm @nick/craft, node #530).
fn set_aside(dir: &Path, found: &str) -> bool {
    let mut aside = dir.as_os_str().to_owned();
    aside.push(format!(".stale-{}", token()));
    let aside = PathBuf::from(aside);
    if std::fs::rename(dir, &aside).is_err() {
        return false;
    }
    let moved = std::fs::read_to_string(aside.join("owner")).unwrap_or_default();
    if moved != found {
        std::fs::rename(&aside, dir).unwrap_or(());
        return false;
    }
    std::fs::remove_dir_all(&aside).unwrap_or(());
    true
}

/// Whether the lock at `dir` was last touched longer than `after` ago.
fn stale(dir: &Path, after: Duration) -> bool {
    std::fs::metadata(dir)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age > after)
}

/// A token no other holder has: this process and the time.
fn token() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("{}-{nanos}", std::process::id())
}

#[cfg(test)]
#[path = "lock_tests.rs"]
mod tests;
