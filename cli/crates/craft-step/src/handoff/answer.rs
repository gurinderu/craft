//! An answer file read back, or set aside once refused — after the state that says why is saved.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{HandoffError, answer_file, answers_dir, safe};
use crate::kind::Kind;
use crate::task::Task;

/// The answer the agent of `task` wrote, or why there is none to read, in one line.
///
/// # Errors
/// The id is no file name, or the file is missing, unreadable, or not JSON.
pub fn read_answer<K: Kind>(dir: &Path, task: &Task<K>) -> Result<Value, String> {
    let path = answer_file(dir, &task.id).map_err(|e| e.to_string())?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("no answer file was written at {}", path.display()));
        }
        Err(e) => {
            return Err(format!(
                "the answer file {} cannot be read: {e}",
                path.display()
            ));
        }
    };
    serde_json::from_str(&text)
        .map_err(|e| format!("the answer file {} is not JSON: {e}", path.display()))
}

/// The refused answer files of a submit, moved aside only once the state that records their
/// refusal is saved ([`Aside::apply`]): a submit cut off before that leaves each where its agent
/// wrote it, to be read again, rather than gone with nothing saying why. Moved aside, a file is
/// not read again as the same refused answer by a retry whose agent writes nothing.
#[derive(Debug, Default)]
#[must_use = "the refused files stay in place until applied"]
pub struct Aside(Vec<(PathBuf, PathBuf, String)>);

impl Aside {
    /// Marks `task`'s answer file to be set aside as `<id>.rejected-<retries>.json`.
    ///
    /// # Errors
    /// When the task's id cannot be a file name.
    pub fn mark<K: Kind>(&mut self, dir: &Path, task: &Task<K>) -> Result<(), HandoffError> {
        let from = answer_file(dir, &task.id)?;
        let stem = format!("{}.rejected-{}", safe(&task.id)?, task.retries);
        self.0.push((from, answers_dir(dir), stem));
        Ok(())
    }

    /// Moves each marked file that is there aside, never over an earlier one: a name taken (a
    /// ladder held or restarted asks again at the same count) gets `.<n>` before `.json`.
    ///
    /// # Errors
    /// When a file exists and cannot be moved.
    pub fn apply(self) -> Result<(), HandoffError> {
        for (from, dir, stem) in self.0 {
            if !from.exists() {
                continue;
            }
            let to = free(&dir, &stem);
            std::fs::rename(&from, &to)
                .map_err(|source| HandoffError::Unmovable { path: from, source })?;
        }
        Ok(())
    }
}

/// `<dir>/<stem>.json`, or the first `<dir>/<stem>.<n>.json` no file holds.
fn free(dir: &Path, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.json"));
    if !first.exists() {
        return first;
    }
    (1..u32::MAX)
        .map(|n| dir.join(format!("{stem}.{n}.json")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_taken_name_is_never_overwritten() {
        let d = tempfile::tempdir().unwrap();
        let dir = answers_dir(d.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("t.rejected-0.json"), "first").unwrap();
        std::fs::write(dir.join("t.json"), "second").unwrap();
        let mut aside = Aside::default();
        aside
            .0
            .push((dir.join("t.json"), dir.clone(), "t.rejected-0".into()));
        aside.apply().unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("t.rejected-0.json")).unwrap(),
            "first"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("t.rejected-0.1.json")).unwrap(),
            "second"
        );
        assert!(!dir.join("t.json").exists());
    }
}
