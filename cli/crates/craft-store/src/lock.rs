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

/// The protocol both writers hold to (`content/parity/lock-protocol.json`, `lib/index-lock.mjs`).
pub const LOCK: &str = "index.jsonl.lock";
pub const STALE: Duration = Duration::from_secs(30);
const WAIT: Duration = Duration::from_millis(20);
pub const TIMEOUT: Duration = Duration::from_secs(45);

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
    let _held = Held { lock, token };
    f()
}

/// The lock this writer holds, released however the writer ends — a panic included — and only
/// while it still holds this writer's token.
struct Held {
    lock: std::path::PathBuf,
    token: String,
}

impl Drop for Held {
    fn drop(&mut self) {
        if std::fs::read_to_string(&self.lock).is_ok_and(|held| held == self.token) {
            drop(std::fs::remove_file(&self.lock));
        }
    }
}

/// One line appended to the store's index under its lock.
///
/// # Errors
/// When the lock cannot be taken or the line cannot be appended.
pub fn append_index_line(store: &Path, line: &str) -> Result<(), StoreError> {
    append_using(store, line, |p, b| std::fs::write(p, b))
}

fn append_using(
    store: &Path,
    line: &str,
    write: impl FnOnce(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(), StoreError> {
    with_index_lock(store, || {
        let index = store.join("index.jsonl");
        let mut bytes = match std::fs::read(&index) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(StoreError::io(&index, &e)),
        };
        if !bytes.is_empty() && !bytes.ends_with(b"\n") {
            bytes.push(b'\n');
        }
        bytes.extend_from_slice(format!("{line}\n").as_bytes());
        crate::write::write_atomically_using(&index, &bytes, write)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appending_to_an_unterminated_row_keeps_both_rows() {
        let d = tempfile::tempdir().unwrap();
        let index = d.path().join("index.jsonl");
        std::fs::write(&index, b"{\"old\":true}").unwrap();
        append_index_line(d.path(), "{\"new\":true}").unwrap();
        assert_eq!(
            std::fs::read(&index).unwrap(),
            b"{\"old\":true}\n{\"new\":true}\n"
        );
    }

    #[test]
    fn interrupted_index_write_does_not_damage_existing_rows() {
        let d = tempfile::tempdir().unwrap();
        let index = d.path().join("index.jsonl");
        std::fs::write(&index, b"existing\n").unwrap();
        let result = append_using(d.path(), "new", |file, _| {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(file)?;
            std::io::Write::write_all(&mut f, b"partial")?;
            Err(std::io::Error::other("interrupted"))
        });
        result.unwrap_err();
        assert_eq!(std::fs::read(&index).unwrap(), b"existing\n");
    }

    #[test]
    fn the_lock_is_the_protocol_the_shared_parity_file_names() {
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../content/parity/lock-protocol.json");
        let want = crate::js::parse(&std::fs::read_to_string(file).unwrap()).unwrap();
        let want = want.as_obj().unwrap();
        assert_eq!(want.text("lockFile"), LOCK);
        let ms = |d: Duration| f64::from(u32::try_from(d.as_millis()).unwrap());
        assert_eq!(
            want.get("staleMs").and_then(crate::js::Js::as_num),
            Some(ms(STALE))
        );
        assert_eq!(
            want.get("timeoutMs").and_then(crate::js::Js::as_num),
            Some(ms(TIMEOUT))
        );
    }

    #[test]
    fn a_writer_that_panics_holding_the_lock_releases_it() {
        let d = tempfile::tempdir().unwrap();
        let store = d.path().to_path_buf();
        let ran = std::panic::catch_unwind(|| {
            with_index_lock(&store, || -> Result<(), StoreError> { panic!("mid-write") })
        });
        drop(ran.unwrap_err());
        assert!(!store.join(LOCK).exists(), "released on the way out");
    }

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
