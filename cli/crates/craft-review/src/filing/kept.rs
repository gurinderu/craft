//! What a run keeps of its telemetry between steps, in `filing.json` beside its state: what every
//! write names of the run, the steps of the current segment as the driver's clock reads them, where
//! its checkpoints went and whether its record is filed.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::is_done;
use crate::state::RunState;

/// Where a run keeps its telemetry between steps.
#[must_use]
pub fn state_path(run: &Path) -> PathBuf {
    run.join("filing.json")
}

/// What every write names of the run, fixed when it opens.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ctx {
    pub repo: String,
    pub head: String,
    pub depth: String,
    pub strict: bool,
    /// craft's plugin root, which holds the adapter; `None`, nothing can be filed.
    pub root: Option<String>,
    /// The engine's craft version the run is filed under, and the parent engine of a nested run.
    pub craft_version: String,
    pub via: String,
    /// The run's identity as it ran, for a record filed after its working copy is gone: the
    /// repository's shared git directory (the round chain's key, empty when the run knew none),
    /// its branch (`None` on a detached `HEAD`) and whether it read uncommitted work. Optional, so
    /// a filing kept before them reads as one that knows none until it is completed from the state.
    #[serde(default)]
    pub git_dir: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub dirty: bool,
    /// The host the run's tasks ran in (`craft review run`'s backend), as the record names it;
    /// empty, the adapter's default, `claude-code` (and a filing kept before it).
    #[serde(default)]
    pub runtime: String,
}

impl Ctx {
    /// The run's own part of it, read off its state.
    #[must_use]
    pub fn of(run: &RunState, craft_version: &str, via: &str) -> Self {
        Self {
            repo: run.context.repo.clone(),
            head: run.diff.head.clone(),
            depth: if run.light { "light" } else { "full" }.into(),
            strict: run.context.strict,
            root: run.context.craft_root.clone(),
            craft_version: craft_version.into(),
            via: via.into(),
            ..Self::default()
        }
        .known_as(run)
    }

    /// `self` with the run's identity read off its state.
    #[must_use]
    pub(super) fn known_as(self, run: &RunState) -> Self {
        Self {
            git_dir: run.chain.repo.clone(),
            branch: run.chain.branch.clone(),
            dirty: run.diff.dirty,
            ..self
        }
    }
}

/// One step the binary printed, as the driver's clock reads it, with the task agents dispatched by then.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Told {
    pub done: bool,
    pub phase: String,
    pub at: Option<u64>,
    pub took: Option<u64>,
    pub agents: u64,
}

impl Told {
    pub(super) fn of(step: &Value, agents: u64) -> Self {
        Self {
            done: is_done(step),
            phase: step
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            at: step.get("at").and_then(Value::as_u64),
            took: step.get("took").and_then(Value::as_u64),
            agents,
        }
    }
}

/// Whether the run's record is in the store.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Record {
    #[default]
    None,
    Filed,
    Failed,
}

/// The run's telemetry between steps.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filing {
    pub ctx: Ctx,
    /// The harness session the segment runs in, stamped on each write.
    #[serde(default)]
    pub session: String,
    /// The store's directory of this segment's checkpoints, empty until one landed.
    #[serde(default)]
    pub run_dir: String,
    /// A checkpoint failed; once one failed with no directory, every later write re-enters this
    /// segment's directory (`--rejoin`), as the engine's rejoin does.
    #[serde(default)]
    pub failed: bool,
    #[serde(default)]
    pub rejoin: bool,
    #[serde(default)]
    pub steps: Vec<Told>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub record: Record,
    /// The record's file in the store, once it landed: what the run's cost is enriched into; and
    /// whether it was last filed again — a resume's re-file of a finished run — rather than for the
    /// work of the invocation that filed it.
    #[serde(default)]
    pub record_file: String,
    #[serde(default)]
    pub refiled: bool,
    /// The finished step the record was first attempted from, so a re-file sends the same record,
    /// and how many times it was attempted: kept before each attempt, so one cut off mid-write is
    /// sent again as a retry.
    #[serde(default)]
    pub finished: Option<Value>,
    #[serde(default)]
    pub attempts: u32,
    /// What the writes after the segment's last step lost, `<what> — <why>`, so a host that lost
    /// that step reads why from `status`.
    #[serde(default)]
    pub lost: Vec<String>,
    /// Stopped segments of the run whose record has not landed, each kept whole — its finished
    /// step, steps and directory — so it is sent again unchanged on every resume until it does.
    #[serde(default)]
    pub pending: Vec<Filing>,
}

pub(super) fn load(run: &Path) -> Option<Filing> {
    let text = std::fs::read_to_string(state_path(run)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Keeps `filing` for the next step, whole or not at all; a state it cannot keep is said, as a lost
/// write is.
pub(super) fn save(run: &Path, filing: &Filing, lost: &mut Vec<String>) {
    let tmp = run.join("filing.json.tmp");
    let kept = serde_json::to_string_pretty(filing)
        .map_err(|e| e.to_string())
        .and_then(|text| std::fs::write(&tmp, text).map_err(|e| e.to_string()))
        .and_then(|()| std::fs::rename(&tmp, state_path(run)).map_err(|e| e.to_string()));
    if let Err(why) = kept {
        lost.push(format!("the run's telemetry state — {why}"));
    }
}
