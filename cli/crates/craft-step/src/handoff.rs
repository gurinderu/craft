//! Tasks and answers travel as files, never through a model's copy (realm @nick/craft, node #453):
//! each pending task's prompt and schema are written under `<run>/tasks/`, its agent writes its
//! answer to `<run>/answers/<id>.json`, and `submit` reads it from there. A task id is its file
//! name, so it is held to a file-safe alphabet.

mod answer;

pub use answer::{Aside, read_answer};

use std::path::{Path, PathBuf};

use crate::kind::Kind;
use crate::task::Task;

/// Why a task's files could not be laid out or moved.
#[derive(Debug, thiserror::Error)]
pub enum HandoffError {
    #[error("creating {}", path.display())]
    NoDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("task id {0:?} cannot be a file name")]
    UnsafeId(String),
    #[error(transparent)]
    Encode(#[from] serde_json::Error),
    #[error("writing {}", path.display())]
    Unwritable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("moving {} aside", path.display())]
    Unmovable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// `<run>/tasks`: each pending task's `<id>.md` prompt and `<id>.schema.json` schema.
#[must_use]
pub fn tasks_dir(dir: &Path) -> PathBuf {
    dir.join("tasks")
}

/// `<run>/answers`: each task's `<id>.json` answer, kept once accepted; a refused one is set aside
/// as `<id>.rejected-<n>.json`.
#[must_use]
pub fn answers_dir(dir: &Path) -> PathBuf {
    dir.join("answers")
}

/// `id` when it can stand as a file name, so every path built from it stays in its directory.
///
/// # Errors
/// [`HandoffError::UnsafeId`] when it cannot.
pub(crate) fn safe(id: &str) -> Result<&str, HandoffError> {
    if file_safe(id) {
        Ok(id)
    } else {
        Err(HandoffError::UnsafeId(id.to_owned()))
    }
}

pub(crate) fn prompt_file(dir: &Path, id: &str) -> Result<PathBuf, HandoffError> {
    Ok(tasks_dir(dir).join(format!("{}.md", safe(id)?)))
}

pub(crate) fn schema_file(dir: &Path, id: &str) -> Result<PathBuf, HandoffError> {
    Ok(tasks_dir(dir).join(format!("{}.schema.json", safe(id)?)))
}

/// Where the agent of task `id` writes its answer.
///
/// # Errors
/// [`HandoffError::UnsafeId`] when `id` cannot be a file name.
pub fn answer_file(dir: &Path, id: &str) -> Result<PathBuf, HandoffError> {
    Ok(answers_dir(dir).join(format!("{}.json", safe(id)?)))
}

/// Whether `id` can stand as a file name: ASCII letters, digits, `.`, `_` and `-`, not starting with `.`.
fn file_safe(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('.')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Writes every pending task's prompt, as the kind renders it (`prompt`: a retry's carries why its
/// last answer was refused), and its schema, and makes the answers directory.
///
/// # Errors
/// When a task id is not file-safe, the kind cannot render a prompt, or a file cannot be written.
pub fn write_pending<K: Kind, E>(
    dir: &Path,
    tasks: &[Task<K>],
    prompt: impl Fn(&Task<K>) -> Result<String, E>,
) -> Result<(), E>
where
    E: From<HandoffError>,
{
    let pending: Vec<&Task<K>> = tasks.iter().filter(|t| t.pending()).collect();
    if pending.is_empty() {
        return Ok(());
    }
    for d in [tasks_dir(dir), answers_dir(dir)] {
        std::fs::create_dir_all(&d).map_err(|source| HandoffError::NoDir { path: d, source })?;
    }
    for task in pending {
        let (prompt_path, schema_path) = (prompt_file(dir, &task.id)?, schema_file(dir, &task.id)?);
        let schema = format!(
            "{}\n",
            serde_json::to_string_pretty(&task.schema).map_err(HandoffError::from)?
        );
        let prompt = prompt(task)?;
        for (path, text) in [(prompt_path, prompt), (schema_path, schema)] {
            std::fs::write(&path, text)
                .map_err(|source| HandoffError::Unwritable { path, source })?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{HandoffError, answer_file, file_safe};

    #[test]
    fn ids_are_held_to_file_names() {
        assert!(file_safe("lens-intent") && file_safe("verify-batch-0") && file_safe("a.b_c"));
        for bad in ["", ".", "..", "a/b", "verify:3", "a b", ".hidden"] {
            assert!(!file_safe(bad), "{bad:?}");
        }
    }

    #[test]
    fn no_path_is_built_from_an_unsafe_id() {
        let got = answer_file(std::path::Path::new("/run"), "../escape");
        assert!(matches!(got, Err(HandoffError::UnsafeId(id)) if id == "../escape"));
    }
}
