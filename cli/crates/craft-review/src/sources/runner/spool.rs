//! A file one of git's outputs goes to, read once git exits: unlike a pipe, nothing git left
//! running (a detached helper still holding the output) can keep the read open.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Tells apart the spools of one process.
static NEXT: AtomicUsize = AtomicUsize::new(0);

/// The file and where it is; removed when dropped.
pub(super) struct Spool {
    path: PathBuf,
    file: File,
}

impl Spool {
    /// A new, empty spool in the temporary directory, readable by this user only.
    pub(super) fn new() -> Result<Self, String> {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("craft-git-{}-{n}", std::process::id()));
        let mut open = OpenOptions::new();
        open.read(true).write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
        let file = open
            .open(&path)
            .map_err(|e| format!("git's output could not be kept: {e}"))?;
        Ok(Self { path, file })
    }

    /// Where git writes.
    pub(super) fn to(&self) -> Result<Stdio, String> {
        self.file
            .try_clone()
            .map(Stdio::from)
            .map_err(|e| format!("git's output could not be kept: {e}"))
    }

    /// What git wrote.
    pub(super) fn text(&mut self) -> Result<String, String> {
        let mut bytes = Vec::new();
        self.file
            .seek(SeekFrom::Start(0))
            .and_then(|_| self.file.read_to_end(&mut bytes))
            .map_err(|e| format!("git's output could not be read: {e}"))?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

impl Drop for Spool {
    fn drop(&mut self) {
        // Gone already: nothing is left to remove.
        std::fs::remove_file(&self.path).unwrap_or(());
    }
}
