//! A private scratch directory in the shared temporary directory for one command's `gh` output:
//! created afresh, never one that is already there, readable by its owner only.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};

/// A new directory `<tmp>/<prefix>-<pid>-<nanos>[-<try>]`, refused rather than reused when a
/// name is taken; the caller removes it.
pub fn dir(prefix: &str) -> Result<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let base = format!("{prefix}-{}-{nanos}", std::process::id());
    for attempt in 0..8 {
        let dir = std::env::temp_dir().join(format!("{base}-{attempt}"));
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
        std::env::temp_dir().display()
    )
}
