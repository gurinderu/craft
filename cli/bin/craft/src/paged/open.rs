//! The step file `craft review page` reads: only `<run>/host-step.out` of a run directory, opened
//! without following a link and checked on the handle it opened, so nothing can be put in its
//! place between a check and the read.

use std::fs::{File, OpenOptions};
use std::path::Path;

use anyhow::{Context, Result};

use super::FILE;

/// The text of the step the run in `run` wrote: its [`FILE`], a regular file with one link,
/// itself no symlink or reparse point, in a directory that holds the run's state.
pub(super) fn read_step(run: &Path) -> Result<String> {
    anyhow::ensure!(
        craft_review::state::state_path(run).is_file(),
        "{} is not a run directory: it holds no run state",
        run.display()
    );
    let path = run.join(FILE);
    let file = open(&path).with_context(|| format!("reading {}", path.display()))?;
    plain(&file).with_context(|| format!("reading {}", path.display()))?;
    // Read from the handle checked, never the path again.
    std::io::read_to_string(file).with_context(|| format!("reading {}", path.display()))
}

/// `path` opened for reading, a symlink in its last component refused by the open itself.
#[cfg(unix)]
fn open(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits())
        .open(path)
}

/// `path` opened for reading, a reparse point opened as itself rather than followed.
#[cfg(windows)]
fn open(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    /// `FILE_FLAG_OPEN_REPARSE_POINT` (Win32 `fileapi.h`).
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open(path: &Path) -> std::io::Result<File> {
    File::open(path)
}

/// That the handle opened is a plain file: a regular file, on unix with no second link to it, on
/// Windows no reparse point.
fn plain(file: &File) -> Result<()> {
    let meta = file.metadata()?;
    anyhow::ensure!(meta.is_file(), "not a regular file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        anyhow::ensure!(meta.nlink() == 1, "the file has {} links", meta.nlink());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        /// `FILE_ATTRIBUTE_REPARSE_POINT` (Win32 `winnt.h`).
        const REPARSE_POINT: u32 = 0x400;
        anyhow::ensure!(
            meta.file_attributes() & REPARSE_POINT == 0,
            "a reparse point"
        );
    }
    Ok(())
}
