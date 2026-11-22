//! An answer file read back, or set aside once refused — after the state that says why is saved.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{HandoffError, answer_file, answers_dir, safe};
use crate::kind::Kind;
use crate::task::Task;

/// The most bytes an answer may hold.
const MAX_ANSWER: u64 = 64 * 1024 * 1024;

/// How many `<stem>.<n>.json` names a refused file may take after `<stem>.json` before its
/// set-aside gives up.
const SLOTS: u32 = 100;

/// What the agent of a task left in its answer file.
#[derive(Debug)]
pub struct Written {
    /// The answer, or why there is none to read, in one line.
    pub answer: Result<Value, String>,
    /// The file's bytes and when it was written, as one string, when it could be read: the same
    /// file read again has the same one, a file its agent writes anew another.
    pub print: Option<String>,
}

/// What the agent of `task` wrote: its answer, or why there is none to read, and its file's print.
#[must_use]
pub fn read_answer<K: Kind>(dir: &Path, task: &Task<K>) -> Written {
    match answer_file(dir, &task.id) {
        Ok(path) => read_capped(&path, MAX_ANSWER),
        Err(e) => Written {
            answer: Err(e.to_string()),
            print: None,
        },
    }
}

/// The answer file at `path`, read through one open handle to at most `cap` bytes. One over it is
/// refused, yet printed over what was read, so left in place it is known again.
fn read_capped(path: &Path, cap: u64) -> Written {
    let unread = |why: String, print: Option<String>| Written {
        answer: Err(why),
        print,
    };
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return unread(
                format!("no answer file was written at {}", path.display()),
                None,
            );
        }
        Err(e) => {
            return unread(
                format!("the answer file {} cannot be read: {e}", path.display()),
                None,
            );
        }
    };
    let meta = file.metadata().ok();
    let modified = meta.as_ref().and_then(|m| m.modified().ok());
    let size = meta.map_or(0, |m| m.len()).min(cap.saturating_add(1));
    let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
    // One byte past the bound, whatever size the file reports, so one over it is told apart.
    if let Err(e) = file.take(cap.saturating_add(1)).read_to_end(&mut bytes) {
        return unread(
            format!("the answer file {} cannot be read: {e}", path.display()),
            None,
        );
    }
    let print = Some(print(&bytes, modified));
    if u64::try_from(bytes.len()).map_or(true, |n| n > cap) {
        return unread(
            format!(
                "the answer file {} holds over the {cap} bytes an answer may",
                path.display()
            ),
            print,
        );
    }
    let answer = serde_json::from_slice(&bytes)
        .map_err(|e| format!("the answer file {} is not JSON: {e}", path.display()));
    Written { answer, print }
}

/// The SHA-256 of `bytes` and the nanoseconds since the epoch of their file's last write, as read
/// from the same open file (empty where the platform gives none).
fn print(bytes: &[u8], modified: Option<SystemTime>) -> String {
    let digest: String = Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let written = modified
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_default();
    format!("{digest}@{written}")
}

/// The refused answer files of a submit, moved aside only once the state that records their
/// refusal is saved ([`Aside::apply`]): a submit cut off before that leaves each where its agent
/// wrote it, to be read again, rather than gone with nothing saying why. The state keeps the print
/// of the file it counted ([`Task::counted`]), so a file read again before it was moved aside is
/// moved aside then uncounted once, and counts as a missing answer if found there once more. Moved
/// aside, a file is not read again as the same refused answer by a retry whose agent writes nothing.
#[derive(Debug, Default)]
#[must_use = "the refused files stay in place until applied"]
pub struct Aside(Vec<Marked>);

/// One file to set aside: its task's id, where it is, and the name it is to take in `dir`.
#[derive(Debug)]
struct Marked {
    id: String,
    known: bool,
    from: PathBuf,
    dir: PathBuf,
    stem: String,
}

/// A marked file [`Aside::apply`] could not move: its task's id, and why.
#[derive(Debug)]
pub struct Unmoved {
    pub id: String,
    /// The file is the one its task's `counted` names ([`Aside::mark_at`]).
    pub known: bool,
    pub error: HandoffError,
}

impl Aside {
    /// Marks `task`'s answer file to be set aside as `<id>.rejected-<retries>.json`.
    ///
    /// # Errors
    /// When the task's id cannot be a file name.
    pub fn mark<K: Kind>(&mut self, dir: &Path, task: &Task<K>) -> Result<(), HandoffError> {
        self.mark_at(dir, task, task.retries, false)
    }

    /// Marks `task`'s answer file to be set aside as refused at `retries`; `known`, it is the
    /// file `task.counted` names, so read again in place it is known by its print.
    ///
    /// # Errors
    /// When the task's id cannot be a file name.
    pub fn mark_at<K: Kind>(
        &mut self,
        dir: &Path,
        task: &Task<K>,
        retries: u32,
        known: bool,
    ) -> Result<(), HandoffError> {
        self.0.push(Marked {
            id: task.id.clone(),
            known,
            from: answer_file(dir, &task.id)?,
            dir: answers_dir(dir),
            stem: format!("{}.rejected-{retries}", safe(&task.id)?),
        });
        Ok(())
    }

    /// Moves each marked file that is there aside, never over another file: a name taken (a
    /// ladder held or restarted asks again at the same count) gets `.<n>` before `.json`. Every
    /// move is tried; those that failed are returned, each file left where it was.
    #[must_use = "a file not moved aside stays where its agent wrote it"]
    pub fn apply(self) -> Vec<Unmoved> {
        self.0
            .into_iter()
            .filter_map(|m| {
                let error = move_aside(&m.from, &m.dir, &m.stem).err()?;
                Some(Unmoved {
                    id: m.id,
                    known: m.known,
                    error,
                })
            })
            .collect()
    }
}

/// Moves `from`, when it is there, to the first free `<dir>/<stem>[.<n>].json`.
fn move_aside(from: &Path, dir: &Path, stem: &str) -> Result<(), HandoffError> {
    let unmovable = |source| HandoffError::Unmovable {
        path: from.to_owned(),
        source,
    };
    match fs::symlink_metadata(from) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(unmovable(e)),
        Ok(_) => {}
    }
    let to = claim(dir, stem).map_err(unmovable)?;
    match fs::rename(from, &to) {
        Ok(()) => Ok(()),
        Err(e) => {
            // The claimed name is still empty and ours: give it back, or leave an empty file
            // that only takes a name.
            if let Err(left) = fs::remove_file(&to) {
                drop(left);
            }
            if e.kind() == ErrorKind::NotFound {
                Ok(())
            } else {
                Err(unmovable(e))
            }
        }
    }
}

/// Creates the first of `<dir>/<stem>.json`, `<dir>/<stem>.1.json`, … no file holds, empty, so no
/// other move takes it; the rename over it then replaces only that.
fn claim(dir: &Path, stem: &str) -> std::io::Result<PathBuf> {
    let names = std::iter::once(format!("{stem}.json"))
        .chain((1..=SLOTS).map(|n| format!("{stem}.{n}.json")));
    for name in names {
        let path = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        ErrorKind::AlreadyExists,
        format!("{stem}.json and its {SLOTS} numbered names are all taken"),
    ))
}

#[cfg(test)]
mod tests;
