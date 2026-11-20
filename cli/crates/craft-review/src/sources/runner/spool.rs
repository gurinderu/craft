//! A file one of git's outputs goes to, read once git exits: unlike a pipe, nothing git left
//! running (a detached helper still holding the output) can keep the read open. Made under a name
//! no other process picks, this user's only, and unlinked at once: git writes through its own
//! handle, craft reads through another with its own offset, and no file is left behind.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// How much of an output is kept: its tail, where git's reason is.
pub(super) const KEEP: u64 = 1 << 20;
/// How many names are tried before giving up.
const TRIES: usize = 8;

/// Tells apart the spools of one process.
static NEXT: AtomicUsize = AtomicUsize::new(0);

/// The reading side of a spool.
pub(super) struct Spool {
    read: File,
}

impl Spool {
    /// A spool in the temporary directory, and the handle git writes to.
    pub(super) fn new() -> io::Result<(Self, File)> {
        let pid = std::process::id();
        let mut names = std::iter::repeat_with(|| {
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or_default();
            format!("craft-git-{pid}-{n}-{nanos:08x}")
        })
        .take(TRIES);
        Self::new_in(&std::env::temp_dir(), &mut names)
    }

    /// A spool in `dir` under the first of `names` no file holds yet.
    fn new_in(dir: &Path, names: &mut dyn Iterator<Item = String>) -> io::Result<(Self, File)> {
        for name in names {
            let path = dir.join(name);
            let mut open = OpenOptions::new();
            open.write(true).create_new(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
            let write = match open.open(&path) {
                Ok(f) => f,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            };
            let read = File::open(&path);
            std::fs::remove_file(&path)?;
            return Ok((Self { read: read? }, write));
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "every name tried was taken",
        ))
    }

    /// What git wrote, its last [`KEEP`] bytes.
    pub(super) fn text(&mut self) -> io::Result<String> {
        let len = self.read.metadata()?.len();
        self.read.seek(SeekFrom::Start(len.saturating_sub(KEEP)))?;
        let mut bytes = Vec::new();
        self.read.read_to_end(&mut bytes)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

#[cfg(test)]
mod tests;
