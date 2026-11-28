//! The degraded notes of a round its host ended without a submit — a stopping signal cut it short,
//! or no account was logged in — kept in the run's directory as its answer files are, so the next
//! submit, a resume's too, takes them beside the answers that landed and the run never reads as a
//! full one (realm @nick/craft, node #752). Nothing is submitted after a stop: the host only writes
//! the file, and the kind reads it.

use std::fmt::Display;
use std::path::{Path, PathBuf};

use crate::handoff::HandoffError;
use crate::take;

/// `<run>/host-degraded.json`: the notes kept for the next submit, as a JSON array of strings.
#[must_use]
pub fn file(dir: &Path) -> PathBuf {
    dir.join("host-degraded.json")
}

/// Keeps `notes` for the run's next submit beside any kept already, each once; nothing is written
/// when none is new.
///
/// # Errors
/// When the file cannot be written.
pub fn keep(dir: &Path, notes: &[String]) -> Result<(), HandoffError> {
    let mut all = kept(dir);
    let before = all.len();
    take::note(&mut all, notes);
    if all.len() == before {
        return Ok(());
    }
    let text = format!("{}\n", serde_json::to_string_pretty(&all)?);
    let (path, tmp) = (file(dir), dir.join("host-degraded.json.tmp"));
    std::fs::write(&tmp, text).map_err(|source| HandoffError::Unwritable {
        path: tmp.clone(),
        source,
    })?;
    std::fs::rename(&tmp, &path).map_err(|source| HandoffError::Unwritable { path, source })
}

/// The notes kept for the next submit: none without the file, and one saying so when it cannot be
/// read, so an unreadable file still marks the run as weaker than asked.
#[must_use]
pub fn kept(dir: &Path) -> Vec<String> {
    let path = file(dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => return vec![unread(&path, e)],
    };
    serde_json::from_str(&text).unwrap_or_else(|e| vec![unread(&path, e)])
}

/// Forgets the kept notes once a saved state holds them; a file left behind is only taken once
/// more, each of its notes kept once.
pub fn forget(dir: &Path) {
    let _gone = std::fs::remove_file(file(dir));
}

fn unread(path: &Path, why: impl Display) -> String {
    format!(
        "the degraded notes the host kept in {} could not be read ({why}): part of this run may have run weaker than it reads.",
        path.display()
    )
}

#[cfg(test)]
mod tests;
