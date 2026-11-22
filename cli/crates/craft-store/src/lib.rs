//! craft's run store (`~/.craft/runs`): the one writer of its run records, the phase checkpoints a
//! run leaves on the way and the index line each record gets, byte for byte as the JavaScript
//! writer (`integrations/shared/craft-log-run.mjs`) writes them and under the same index lock, so both can write one
//! store while the Workflow engine still files through it (realm @nick/craft, nodes #401, #539);
//! and the streaming reader `craft runs` lists, sums and checks the store with (#540).

pub mod adapter;
pub mod check;
pub mod checkpoint;
mod cli_record;
mod clock;
pub mod filter;
pub mod finalize;
pub mod git;
pub mod js;
pub mod lock;
pub mod parts;
pub mod process_identity;
pub mod proof;
mod publication;
pub mod read;
pub mod record;
pub mod retro;
pub mod tally;
pub mod time;
pub mod write;

use std::path::Path;

/// Why a store write did not land.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StoreError {
    #[error("{path}: {why}")]
    Io { path: String, why: String },
    #[error("{0}")]
    Locked(String),
    #[error("{0}")]
    Refused(String),
}

impl StoreError {
    pub(crate) fn io(path: &Path, e: &std::io::Error) -> Self {
        Self::Io {
            path: path.display().to_string(),
            why: e.to_string(),
        }
    }
}

impl From<js::Utf16Error> for StoreError {
    fn from(e: js::Utf16Error) -> Self {
        Self::Refused(e.to_string())
    }
}

/// Answers one of the binary's writes — `checkpoint`, `finalize` or `publication` — over the
/// request it built, as the JavaScript adapter answered it.
///
/// # Errors
/// On a command no write answers to, or a request that is not a JSON object.
pub fn answer(
    command: &str,
    request: &serde_json::Value,
    env: &adapter::Env,
) -> Result<serde_json::Value, StoreError> {
    let js::Js::Obj(req) = js::Js::from(request) else {
        return Err(StoreError::Refused(
            "the request is not a JSON object".into(),
        ));
    };
    let out = answer_js(command, &req, env)?;
    serde_json::Value::try_from(&js::Js::Obj(out)).map_err(|e| StoreError::Refused(e.to_string()))
}

/// Opens one write of the binary's: the git probes that timed out before it are forgotten, so its
/// record names its own — the `craftCommit` probe its caller runs first among them.
pub fn begin_write() {
    drop(git::take_timed_out());
}

/// [`answer`] over a request read as JavaScript reads it.
///
/// # Errors
/// On a command no write answers to.
pub fn answer_js(command: &str, req: &js::Obj, env: &adapter::Env) -> Result<js::Obj, StoreError> {
    Ok(match command {
        "checkpoint" => adapter::checkpoint(req, env),
        "finalize" => adapter::record(req, env),
        "publication" => publication::answer(req),
        other => return Err(StoreError::Refused(format!("no write is called {other}"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_craft_commit_probe_that_timed_out_before_the_write_is_named_in_its_record() {
        let (store, repo) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        drop(git::take_timed_out());
        begin_write();
        git::note_timed_out(&["rev-parse", "--short", "HEAD"]);
        let step = js::Obj::new()
            .with("report", js::Js::str("/r/report.md"))
            .with("verdict", js::Js::str("Approve"));
        let req = js::Obj::new()
            .with("repo", js::Js::str(repo.path().display().to_string()))
            .with("step", js::Js::Obj(step));
        let env = adapter::Env {
            store: store.path().to_path_buf(),
            craft_commit: None,
            now: 0,
        };
        let done = answer_js("finalize", &req, &env).unwrap();
        drop(git::take_timed_out());
        let rec = read::record(
            store.path(),
            done.text("file").unwrap().rsplit('/').next().unwrap(),
        )
        .unwrap();
        let named = rec
            .get("gitTimedOut")
            .map(js::Js::compact)
            .unwrap_or_default();
        assert!(named.contains("git rev-parse --short HEAD"), "{named}");
        assert_eq!(rec.get("craftCommit"), Some(&js::Js::Null));
    }
}
