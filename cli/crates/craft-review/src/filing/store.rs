//! The real write: the binary's own store writer (`craft-store`, realm @nick/craft, node #539) over
//! `~/.craft/runs`, with no node and no plugin root needed. The plugin root the run knows, when it
//! knows one, names only the craft whose commit the record is stamped with (`craftCommit`).

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::wire::{Call, WriteError, Writer};

/// Writes into `store`, else `~/.craft/runs`.
#[derive(Debug, Clone, Default)]
pub struct StoreWriter {
    pub store: Option<PathBuf>,
}

impl Writer for StoreWriter {
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError> {
        let store = self
            .store
            .clone()
            .or_else(craft_store::read::home_store)
            .ok_or(WriteError::NoStore)?;
        // Opened before the craftCommit probe, so the record names it when it timed out.
        craft_store::begin_write();
        let commit = (!call.root.is_empty())
            .then(|| craft_store::git::git(&["rev-parse", "--short", "HEAD"], Path::new(call.root)))
            .filter(|c| !c.is_empty());
        let env = craft_store::adapter::Env {
            store,
            craft_commit: commit,
            now: craft_store::time::now_ms(),
        };
        craft_store::answer(call.command, call.request, &env)
            .map_err(|e| WriteError::Store(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_checkpoint_lands_in_the_store_it_is_given_with_no_plugin_root() {
        let (store, repo) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let w = StoreWriter {
            store: Some(store.path().to_path_buf()),
        };
        let request =
            json!({"repo": repo.path(), "craftVersion": "0.55.0", "start": true, "steps": []});
        let call = Call {
            run: repo.path(),
            root: "",
            command: "checkpoint",
            request: &request,
        };
        let got = w.write(&call).unwrap();
        let dir = got["runDir"].as_str().unwrap();
        assert!(
            dir.starts_with(&store.path().display().to_string()),
            "{got}"
        );
        assert!(Path::new(dir).join("00-start.json").is_file());
    }

    #[test]
    fn a_write_no_store_answers_to_is_refused() {
        let w = StoreWriter::default();
        let call = Call {
            run: Path::new("/r"),
            root: "",
            command: "nothing",
            request: &json!({}),
        };
        assert!(matches!(w.write(&call), Err(WriteError::Store(_))));
    }
}
