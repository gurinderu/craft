//! Private staging and publication: never unlink a public detail on an error.
use crate::StoreError;
use std::path::{Path, PathBuf};

pub(crate) fn sync(file: &Path) -> Result<(), StoreError> {
    let directory = std::fs::metadata(file)
        .map_err(|e| StoreError::io(file, &e))?
        .is_dir();
    // Windows has no directory-fsync contract here; replay covers process crashes, not power loss.
    #[cfg(windows)]
    if directory {
        return Ok(());
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(!directory)
        .open(file)
        .and_then(|f| f.sync_all())
        .map_err(|e| StoreError::io(file, &e))
}

fn stage(root: &Path) -> Result<PathBuf, StoreError> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    stage_using(root, || {
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!(
            ".filing-stage-{}-{}-{n}",
            std::process::id(),
            crate::time::now_ms()
        )
    })
}

fn stage_using(root: &Path, mut name: impl FnMut() -> String) -> Result<PathBuf, StoreError> {
    for _ in 0..60 {
        let dir = root.join(name());
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(StoreError::io(&dir, &e)),
        }
    }
    Err(StoreError::Refused("60 filing stage names taken".into()))
}

pub(crate) fn retire(dir: &Path, store: &Path) -> Result<(), StoreError> {
    let retired = stage(store)?;
    std::fs::rename(dir, retired.join("run")).map_err(|e| StoreError::io(dir, &e))?;
    if let Some(parent) = dir.parent() {
        sync(parent)?;
    }
    sync(&retired)?;
    std::fs::remove_dir_all(&retired).map_err(|e| StoreError::io(&retired, &e))
}

pub(crate) fn publish(file: &Path, text: &str, replace: bool) -> Result<(), StoreError> {
    publish_using(file, text, replace, |f, bytes| {
        std::io::Write::write_all(f, bytes)
    })
}

fn publish_using(
    file: &Path,
    text: &str,
    replace: bool,
    write: impl FnOnce(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
) -> Result<(), StoreError> {
    let root = file
        .parent()
        .ok_or_else(|| StoreError::Refused("filing has no parent".into()))?;
    let dir = stage(root)?;
    let tmp = dir.join(
        file.file_name()
            .ok_or_else(|| StoreError::Refused("filing has no name".into()))?,
    );
    let result = prepared(&tmp, text, write).and_then(|()| {
        if replace {
            std::fs::rename(&tmp, file)
        } else {
            std::fs::hard_link(&tmp, file)
        }
        .map_err(|e| StoreError::io(file, &e))?;
        sync(root)
    });
    let cleanup = std::fs::remove_dir_all(&dir).map_err(|e| StoreError::io(&dir, &e));
    match (result, cleanup) {
        (Err(a), Err(b)) => Err(StoreError::Refused(format!("{a}; cleanup failed: {b}"))),
        (Err(e), _) | (_, Err(e)) => Err(e),
        _ => Ok(()),
    }
}

fn prepared(
    file: &Path,
    text: &str,
    write: impl FnOnce(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
) -> Result<(), StoreError> {
    let mut f = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(file)
        .map_err(|e| StoreError::io(file, &e))?;
    write(&mut f, text.as_bytes())
        .and_then(|()| f.sync_all())
        .map_err(|e| StoreError::io(file, &e))?;
    let back = std::fs::read_to_string(file).map_err(|e| StoreError::io(file, &e))?;
    if back != text {
        return Err(StoreError::Refused(format!(
            "readback disagrees: {}",
            file.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_readback_publishes_nothing_and_never_removes_another_writers_file() {
        for concurrent in [false, true] {
            let d = tempfile::tempdir().unwrap();
            let file = d.path().join("record.json");
            let error = publish_using(&file, "complete", false, |f, _bytes| {
                std::io::Write::write_all(f, b"partial")?;
                if concurrent {
                    std::fs::write(&file, "foreign")?;
                }
                Ok(())
            })
            .unwrap_err();
            assert!(error.to_string().contains("readback disagrees"));
            if concurrent {
                assert_eq!(std::fs::read_to_string(&file).unwrap(), "foreign");
            } else {
                assert!(!file.exists());
            }
        }
    }

    #[test]
    fn interrupted_staging_never_publishes_partial_bytes() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("record.json");
        let interrupted = std::panic::catch_unwind(|| {
            let _result = publish_using(&file, "complete", false, |f, _bytes| {
                std::io::Write::write_all(f, b"partial")?;
                panic!("interrupted before verification")
            });
        });
        assert!(interrupted.is_err());
        assert!(!file.exists());
    }
    #[test]
    fn staging_name_exhaustion_refuses_without_touching_the_occupied_directory() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join("taken")).unwrap();
        std::fs::write(d.path().join("taken/keep"), "foreign").unwrap();
        let mut attempts = 0;
        let error = stage_using(d.path(), || {
            attempts += 1;
            "taken".into()
        })
        .unwrap_err();
        assert_eq!(attempts, 60);
        assert!(error.to_string().contains("60 filing stage names"));
        assert_eq!(
            std::fs::read_to_string(d.path().join("taken/keep")).unwrap(),
            "foreign"
        );
    }
}
