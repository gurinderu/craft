//! craft's run store (`~/.craft/runs`): the one writer of its run records, the phase checkpoints a
//! run leaves on the way and the index line each record gets, byte for byte as the JavaScript
//! writer (`lib/craft-log-run.mjs`) writes them and under the same index lock, so both can write one
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
    answer_js(command, &req, env).map(|out| serde_json::Value::from(&js::Js::Obj(out)))
}

/// [`answer`] over a request read as JavaScript reads it.
///
/// # Errors
/// On a command no write answers to.
pub fn answer_js(command: &str, req: &js::Obj, env: &adapter::Env) -> Result<js::Obj, StoreError> {
    // Each write names only the git probes that timed out in it.
    drop(git::take_timed_out());
    Ok(match command {
        "checkpoint" => adapter::checkpoint(req, env),
        "finalize" => adapter::record(req, env),
        "publication" => publication::answer(req),
        other => return Err(StoreError::Refused(format!("no write is called {other}"))),
    })
}
