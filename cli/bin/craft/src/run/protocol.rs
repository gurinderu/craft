//! The step protocol (realm @nick/craft, node #453) as `craft review run` drives it: the same
//! `start`, `submit`, `status` and `comment` the commands print, called in this process
//! ([`InProcess`]) rather than through a shell, so the loop and the commands cannot drift apart.

use std::path::{Path, PathBuf};

use anyhow::Result;
use craft_review::filing;
use serde_json::Value;

use crate::comment::{CommentArgs, comment_step};
use crate::steps::{StartArgs, SubmitArgs, start_step, status_step, submit_step};

/// What a submit tells the binary of the step's tasks.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct Said {
    pub(crate) degraded: Vec<String>,
    pub(crate) abandoned: Vec<String>,
    pub(crate) limit: Option<String>,
    pub(crate) resume: bool,
    /// The task agents dispatched so far, for the run's telemetry.
    pub(crate) agents: u64,
}

/// The binary's side of the loop.
pub(crate) trait Protocol {
    /// Opens the run: its first step.
    fn start(&self) -> Result<Value>;
    /// Hands in the step's answers: the next step.
    fn submit(&self, run: &Path, said: &Said) -> Result<Value>;
    /// Where the run stands.
    fn status(&self, run: &Path) -> Result<Value>;
    /// Publishes a finished run on its PR: its finished step.
    fn comment(&self, run: &Path) -> Result<Value>;
    /// Files the INCOMPLETE record of a run the loop stopped driving: what did not land; `None`
    /// when nothing was filed.
    fn unfinished(&self, run: &Path, why: &str) -> Option<Vec<String>>;
}

/// The protocol in this process: the commands' own functions.
pub(crate) struct InProcess {
    /// The start's arguments, `--record` set.
    pub(crate) start: StartArgs,
    /// The plugin root the run's telemetry is filed through.
    pub(crate) record_root: PathBuf,
}

impl Protocol for InProcess {
    fn start(&self) -> Result<Value> {
        start_step(&self.start)
    }

    fn submit(&self, run: &Path, said: &Said) -> Result<Value> {
        submit_step(&SubmitArgs {
            run: run.to_path_buf(),
            answers: None,
            degraded: said.degraded.clone(),
            limit: said.limit.clone(),
            resume: said.resume,
            abandoned: said.abandoned.clone(),
            agents: Some(said.agents),
            // Neither host prints what its tasks spent in output tokens alone.
            output_tokens: None,
            record_root: Some(self.record_root.clone()),
        })
    }

    fn status(&self, run: &Path) -> Result<Value> {
        status_step(run)
    }

    fn comment(&self, run: &Path) -> Result<Value> {
        comment_step(&CommentArgs {
            run: run.to_path_buf(),
            pr: self.start.pr,
            record_root: Some(self.record_root.clone()),
        })
    }

    fn unfinished(&self, run: &Path, why: &str) -> Option<Vec<String>> {
        filing::unfinished(run, why, &filing::NodeWriter)
    }
}
