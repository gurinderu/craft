//! A file's text, read only when it is a regular file of bounded size: a changed file, or a
//! graph caller's file reached from the top through no link.

use std::io::{ErrorKind, Read};
use std::path::{Component, Path};

/// How much of a changed file is read; a larger one is said, not read.
const READ_MAX: u64 = 4 << 20;

/// Why a changed file's text was not read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum Unreadable {
    #[error("not a regular file")]
    NotRegular,
    #[error("outside the repository")]
    Outside,
    #[error("reached through a link")]
    Linked,
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
pub(crate) fn read(path: &Path) -> Result<String, Unreadable> {
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

/// The text of `rel` under `top` as [`read`] reads it, `None` when it is absent; refused when
/// `rel` leaves `top` (absolute, `..`) or any directory on the way is a link.
///
/// # Errors
/// As [`read`], and when `rel` leaves `top` or passes through a link.
pub(crate) fn read_within(top: &Path, rel: &str) -> Result<Option<String>, Unreadable> {
    let path = Path::new(rel);
    let mut at = top.to_path_buf();
    for c in path.components() {
        let Component::Normal(name) = c else {
            if c == Component::CurDir {
                continue;
            }
            return Err(Unreadable::Outside);
        };
        at.push(name);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_symlink() => return Err(Unreadable::Linked),
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        }
    }
    read(&at).map(Some)
}
