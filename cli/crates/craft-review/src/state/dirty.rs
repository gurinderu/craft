//! Whether a run read uncommitted work, read from its state whatever the state's format version:
//! `diff.dirty` has kept its place and meaning across them, so a record of a run another craft
//! started (an older or a newer format) can still be posted from (`craft review post`).

use std::path::Path;

use serde_json::Value;

use super::{StateError, state_path};

/// The run in `dir`'s own `diff.dirty`: tracked files changed when the review started.
///
/// # Errors
/// When the state cannot be read, is not JSON, or names no `diff.dirty`.
pub fn dirty_of(dir: &Path) -> Result<bool, StateError> {
    let path = state_path(dir);
    let text = std::fs::read_to_string(&path).map_err(|source| StateError::Unreadable {
        path: path.clone(),
        source,
    })?;
    let v: Value = serde_json::from_str(&text).map_err(|source| StateError::Malformed {
        path: path.clone(),
        source,
    })?;
    v.get("diff")
        .and_then(|d| d.get("dirty"))
        .and_then(Value::as_bool)
        .ok_or(StateError::NoDirty { path })
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_state_of_another_shape_still_tells_its_dirty_flag() {
        let dir = tempfile::tempdir().unwrap();
        let state = r#"{"version": 1, "tracks": "not a list", "phase": 7, "diff": {"dirty": true, "files": 3}}"#;
        std::fs::write(dir.path().join("state.json"), state).unwrap();
        assert!(super::dirty_of(dir.path()).unwrap());
        std::fs::write(dir.path().join("state.json"), r#"{"diff": {"files": []}}"#).unwrap();
        assert!(matches!(
            super::dirty_of(dir.path()),
            Err(super::StateError::NoDirty { .. })
        ));
    }
}
