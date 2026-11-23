//! A private scratch directory in the shared temporary directory for one command's `gh` output:
//! created afresh, never one that is already there, readable by its owner only.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

/// A new directory `<tmp>/<prefix>-<pid>-<nanos>[-<try>]`, refused rather than reused when a
/// name is taken; the caller removes it.
pub fn dir(prefix: &str) -> Result<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    dir_in(
        &std::env::temp_dir(),
        &format!("{prefix}-{}-{nanos}", std::process::id()),
    )
}

/// [`dir`] under `tmp`, its names `<base>-<try>`.
fn dir_in(tmp: &Path, base: &str) -> Result<PathBuf> {
    for attempt in 0..8 {
        let dir = tmp.join(format!("{base}-{attempt}"));
        let mut b = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        match b.create(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e).with_context(|| format!("creating {}", dir.display())),
        }
    }
    bail!(
        "every scratch directory name under {} for {base} is taken",
        tmp.display()
    )
}

#[cfg(test)]
mod tests {
    use super::dir_in;

    #[test]
    fn a_taken_name_is_skipped_never_reused_and_the_new_one_is_its_owners_only() {
        let tmp = tempfile::tempdir().unwrap();
        let taken = tmp.path().join("s-0");
        std::fs::create_dir(&taken).unwrap();
        std::fs::write(taken.join("theirs"), "x").unwrap();
        let fresh = dir_in(tmp.path(), "s").unwrap();
        assert_eq!(fresh, tmp.path().join("s-1"));
        assert!(std::fs::read_dir(&fresh).unwrap().next().is_none(), "empty");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&fresh).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        for i in 2..8 {
            std::fs::create_dir(tmp.path().join(format!("s-{i}"))).unwrap();
        }
        assert!(
            dir_in(tmp.path(), "s").is_err(),
            "every name taken: refused"
        );
    }
}
