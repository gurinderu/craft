//! A run's state between steps, kept in `state.json` in its run directory: the change, the
//! current phase, the tasks the host is to run, and what their answers said.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::git::Diff;
use crate::prompts::PromptContext;

/// The state file's format; a run written by another format is refused, not misread.
pub const STATE_VERSION: u32 = 3;
/// How many times an invalid or missing answer is asked for again before its task fails.
pub const MAX_RETRIES: u32 = 2;

/// Where a run stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Lens,
    Verify,
    Done,
}

/// What a task's answer is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskKind {
    Lens,
    Verify { finding: usize },
    VerifyBatch { findings: Vec<usize> },
}

/// Whether a task still waits for its answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Pending,
    Answered,
    /// Its retries are spent without a valid answer.
    Failed,
}

/// One agent the host is to run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub label: String,
    pub prompt: String,
    pub model: String,
    pub schema: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(flatten)]
    pub kind: TaskKind,
    pub state: TaskState,
    /// Answers asked for again so far.
    pub retries: u32,
    /// Why the last answer was refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<Value>,
}

impl Task {
    #[must_use]
    pub fn new(
        id: String,
        label: String,
        prompt: String,
        model: &str,
        schema: Value,
        kind: TaskKind,
    ) -> Self {
        Self {
            id,
            label,
            prompt,
            model: model.to_owned(),
            schema,
            agent_type: None,
            kind,
            state: TaskState::Pending,
            retries: 0,
            error: None,
            answer: None,
        }
    }

    /// The task's prompt as its agent reads it; a retry's carries why the last answer was refused.
    #[must_use]
    pub fn prompt_text(&self) -> String {
        match &self.error {
            Some(e) => format!(
                "{}\n\nYour previous answer was invalid: {e}. Answer again, matching the schema exactly.",
                self.prompt
            ),
            None => self.prompt.clone(),
        }
    }
}

/// Everything a run keeps between steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunState {
    pub version: u32,
    pub context: PromptContext,
    pub diff: Diff,
    pub rust_files: Vec<String>,
    pub phase: Phase,
    /// The current phase's tasks.
    pub tasks: Vec<Task>,
    /// What the lens reported, each a finding object as its schema shapes it.
    pub findings: Vec<Value>,
    /// The verifier's verdict on each finding, by index; `None` while none is in.
    pub votes: Vec<Option<Value>>,
    /// What went wrong on the way, for the report.
    pub notes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<String>,
}

/// The state file of the run in `dir`.
#[must_use]
pub fn state_path(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

/// The report of the run in `dir`.
#[must_use]
pub fn report_path(dir: &Path) -> PathBuf {
    dir.join("report.md")
}

/// Reads the run in `dir`.
///
/// # Errors
/// When there is no state file, it is not JSON of this format, or its version differs.
pub fn load(dir: &Path) -> Result<RunState> {
    let path = state_path(dir);
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("reading the run state {}", path.display()))?;
    let state: RunState = serde_json::from_str(&text)
        .with_context(|| format!("parsing the run state {}", path.display()))?;
    anyhow::ensure!(
        state.version == STATE_VERSION,
        "the run state {} is format {}, this craft reads {STATE_VERSION}",
        path.display(),
        state.version
    );
    Ok(state)
}

/// Writes the run's state into `dir`, whole or not at all.
///
/// # Errors
/// When the file cannot be written.
pub fn save(dir: &Path, state: &RunState) -> Result<()> {
    let path = state_path(dir);
    let tmp = dir.join("state.json.tmp");
    std::fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(state)?))
        .with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, &path).with_context(|| format!("writing {}", path.display()))
}
