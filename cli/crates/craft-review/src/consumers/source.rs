//! A changed file's text, read only when it is a regular file of bounded size.

use std::io::Read;
use std::path::Path;

/// How much of a changed file is read; a larger one is said, not read.
const READ_MAX: u64 = 4 << 20;

/// Why a changed file's text was not read.
#[derive(Debug, thiserror::Error)]
pub(super) enum Unreadable {
    #[error("not a regular file")]
    NotRegular,
    #[error("larger than {READ_MAX} bytes")]
    TooLarge,
    #[error("not UTF-8: {0}")]
    NotUtf8(#[from] std::string::FromUtf8Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// The text of the regular file at `path`, read up to [`READ_MAX`].
///
/// # Errors
/// When it is not a regular file (a link, a device, a FIFO), is larger, is not UTF-8 or cannot be
/// read.
pub(super) fn read(path: &Path) -> Result<String, Unreadable> {
    if !std::fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(Unreadable::NotRegular);
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(READ_MAX + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > READ_MAX {
        return Err(Unreadable::TooLarge);
    }
    Ok(String::from_utf8(bytes)?)
}
