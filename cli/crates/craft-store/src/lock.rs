//! The store's index lock, the protocol of `lib/index-lock.mjs` (realm @nick/craft, node #401), so a
//! JavaScript writer and this one never interleave on `index.jsonl`: a file created exclusively
//! beside the index, holding its owner's token; one older than 30 s is a writer that died holding
//! it, renamed aside and put back when what was renamed turns out to be a fresh lock taken in
//! between; waiting is bounded at 45 s.

use std::io::ErrorKind;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};

use crate::StoreError;

const LOCK: &str = "index.jsonl.lock";
const STALE: Duration = Duration::from_secs(30);
const WAIT: Duration = Duration::from_millis(20);
const TIMEOUT: Duration = Duration::from_secs(45);

/// A token no other writer holds: this process and a count, mixed with the clock.
fn token() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let n = N.fetch_add(1, Ordering::Relaxed);
    let mixed = (u64::from(nanos) << 16 ^ n) & 0xffff_ffff_ffff;
    format!("{}-{mixed:012x}", std::process::id())
}

fn create(lock: &Path, token: &str) -> std::io::Result<bool> {
    let made = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock);
    match made {
        Ok(mut f) => std::io::Write::write_all(&mut f, token.as_bytes()).map(|()| true),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

fn is_stale(file: &Path) -> std::io::Result<bool> {
    let age = std::fs::metadata(file)?.modified()?.elapsed();
    Ok(age.is_ok_and(|a| a >= STALE))
}

/// Takes over a stale lock: `Ok(true)` when the lock is gone, `Ok(false)` when it is held fresh, or
/// why a stale one stayed in place.
fn take_over(lock: &Path, token: &str) -> Result<bool, String> {
    match is_stale(lock) {
        Ok(false) => return Ok(false),
        Ok(true) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(format!("stat {e}")),
    }
    let aside = lock.with_file_name(format!("{LOCK}.stale-{token}"));
    match std::fs::rename(lock, &aside) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(format!("the stale lock could not be removed ({e})")),
    }
    let fresh = !is_stale(&aside).unwrap_or(true);
    if fresh {
        // A lock exists again when the link fails: its writer holds the index.
        drop(std::fs::hard_link(&aside, lock));
    }
    drop(std::fs::remove_file(&aside));
    Ok(!fresh)
}

/// Runs `f` holding the store's index lock, and releases it however `f` ends.
///
/// # Errors
/// When the lock cannot be taken within the bound, or the store cannot be made.
pub fn with_index_lock<T>(
    store: &Path,
    f: impl FnOnce() -> Result<T, StoreError>,
) -> Result<T, StoreError> {
    std::fs::create_dir_all(store).map_err(|e| StoreError::io(store, &e))?;
    let lock = store.join(LOCK);
    let token = token();
    let deadline = Instant::now() + TIMEOUT;
    let mut why = "held by another writer".to_owned();
    while !create(&lock, &token).map_err(|e| StoreError::io(&lock, &e))? {
        let gone = match take_over(&lock, &token) {
            Ok(gone) => gone,
            Err(e) => {
                why = e;
                false
            }
        };
        if Instant::now() >= deadline {
            return Err(StoreError::Locked(format!(
                "index.jsonl stays locked: {why} ({}) — retry, or remove the lock if no craft writer is running",
                lock.display()
            )));
        }
        if !gone {
            std::thread::sleep(WAIT);
        }
    }
    let out = f();
    if std::fs::read_to_string(&lock).is_ok_and(|held| held == token) {
        drop(std::fs::remove_file(&lock));
    }
    out
}

/// One line appended to the store's index under its lock.
///
/// # Errors
/// When the lock cannot be taken or the line cannot be appended.
pub fn append_index_line(store: &Path, line: &str) -> Result<(), StoreError> {
    with_index_lock(store, || {
        let index = store.join("index.jsonl");
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&index)
            .map_err(|e| StoreError::io(&index, &e))?;
        std::io::Write::write_all(&mut f, format!("{line}\n").as_bytes())
            .map_err(|e| StoreError::io(&index, &e))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_lock_held_by_another_writer_is_waited_for_and_a_stale_one_taken_over() {
        let d = tempfile::tempdir().unwrap();
        let lock = d.path().join(LOCK);
        std::fs::write(&lock, "other").unwrap();
        let old = SystemTime::now() - Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(old)
            .unwrap();
        append_index_line(d.path(), "{}").unwrap();
        assert_eq!(
            std::fs::read_to_string(d.path().join("index.jsonl")).unwrap(),
            "{}\n"
        );
        assert!(!lock.exists(), "released");
    }

    #[test]
    fn a_lock_another_writer_took_is_not_released() {
        let d = tempfile::tempdir().unwrap();
        let lock = d.path().join(LOCK);
        with_index_lock(d.path(), || {
            std::fs::write(&lock, "someone else").map_err(|e| StoreError::io(&lock, &e))
        })
        .unwrap();
        assert!(lock.exists());
    }
}
