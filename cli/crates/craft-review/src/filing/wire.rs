//! What the adapter (`lib/cli-review-file.mjs`) is handed for a checkpoint or the record, and what
//! it answers — the field names its `common`, `checkpoint` and `finalize` read — and the writer
//! that carries them.

use serde::{Deserialize, Serialize};
use std::path::Path;

use serde_json::Value;

use super::{Filing, Told};

/// The fields both writes carry.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Common<'a> {
    pub(super) repo: &'a str,
    pub(super) craft_version: &'a str,
    pub(super) session: &'a str,
    pub(super) dir: &'a str,
    pub(super) rejoin: bool,
    pub(super) steps: &'a [Told],
    pub(super) head: &'a str,
}

impl<'a> Common<'a> {
    pub(super) fn of(filing: &'a Filing, rejoin: bool) -> Self {
        Self {
            repo: &filing.ctx.repo,
            craft_version: &filing.ctx.craft_version,
            session: &filing.session,
            dir: &filing.run_dir,
            rejoin,
            steps: &filing.steps,
            head: &filing.ctx.head,
        }
    }
}

/// A checkpoint as the adapter takes it: the start's, or the one of the phase the steps ended.
#[derive(Serialize)]
pub(super) struct CheckpointAsked<'a> {
    #[serde(flatten)]
    pub(super) common: Common<'a>,
    pub(super) start: bool,
}

/// What the adapter answered a checkpoint.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct CheckpointDone {
    pub(super) skipped: bool,
    pub(super) phase: String,
    pub(super) run_dir: String,
    pub(super) error: String,
}

/// The record as the adapter takes it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecordAsked<'a> {
    #[serde(flatten)]
    pub(super) common: Common<'a>,
    pub(super) step: &'a Value,
    pub(super) retry: bool,
    pub(super) depth: &'a str,
    pub(super) strict: bool,
    pub(super) via: &'a str,
    pub(super) output_tokens: Option<u64>,
}

/// What the adapter answered the record: whether it landed, and the logger's warning or failure.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct RecordDone {
    pub(super) ok: bool,
    pub(super) reason: String,
    /// The record file the store holds, as craft-log-run named it (`wrote` or `already filed`).
    pub(super) file: String,
}

/// One write as the adapter is asked for it.
#[derive(Debug, Clone, Copy)]
pub struct Call<'a> {
    pub run: &'a Path,
    pub root: &'a str,
    pub repo: &'a str,
    /// `checkpoint` or `finalize`.
    pub command: &'a str,
    pub request: &'a Value,
}

/// Why a write did not come back with an answer.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WriteError {
    #[error("no craft plugin root is known to the run, so the record writer cannot be found")]
    NoRoot,
    #[error("node is not on the PATH")]
    NoNode,
    #[error("the record writer did not finish within {0} s")]
    TimedOut(u64),
    #[error("the record writer could not run: {0}")]
    Broken(String),
    #[error("the record writer exited non-zero: {0}")]
    Exited(String),
    #[error("the record writer printed no answer: {0}")]
    NoAnswer(String),
}

/// Runs a write: the real one spawns node over the adapter ([`super::NodeWriter`]).
pub trait Writer {
    /// The JSON object the adapter answered.
    ///
    /// # Errors
    /// When it could not be run or printed no answer.
    fn write(&self, call: &Call<'_>) -> Result<Value, WriteError>;
}
