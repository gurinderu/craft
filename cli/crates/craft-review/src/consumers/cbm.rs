//! The code graph as the binary asks it: `codebase-memory-mcp cli --quiet <tool> '<json>'`, one
//! process per question, its payload JSON on stdout (`"format": "json"`), bounded in time
//! (realm @nick/craft, node #529). A review indexes the checkout it reads before it asks
//! ([`Cbm::reindex`]).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::cancel::Cancel;

mod callers;
mod error;
mod index;
mod lock;
mod probe;
mod query;
mod reindex;
mod rows;
mod run;

use run::{bounded, last_line};

pub use error::CbmError;
pub use index::Index;
pub use lock::{review_locks, scratch_locks};

pub use probe::{RECORD, look, probe, roots_of, said};

/// The program `craft init` asks.
pub const TOOL: &str = "codebase-memory-mcp";
/// How long one question may run.
const TIMEOUT: Duration = Duration::from_secs(30);
/// How long the callers of all a review's symbols may take, past which the rest are not asked.
const CALLERS_BUDGET: Duration = Duration::from_secs(90);
/// How many caller rows one symbol's query keeps.
pub(super) const ROWS_PER_SYMBOL: usize = 50;

/// One caller the graph names: the called symbol, the file it is defined in, the calling
/// function's file and line span, and the call's own line when the edge names one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    pub symbol: String,
    pub defined_in: String,
    pub file: String,
    pub start: u32,
    pub end: u32,
    pub line: Option<u32>,
}

/// The graph's callers of a review's symbols, and the symbols whose callers were cut at
/// [`ROWS_PER_SYMBOL`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Asked {
    pub callers: Vec<Caller>,
    pub truncated: Vec<String>,
    /// The symbols whose callers were not asked, each with why: `name (why)`.
    pub unasked: Vec<String>,
}

/// The graph's program, asked within a time bound.
#[derive(Debug, Clone)]
pub struct Cbm {
    pub tool: String,
    /// How long one question may run.
    pub timeout: Duration,
    /// How long the callers of all a review's symbols may take.
    pub budget: Duration,
    /// A stop asked of the run: the question running is killed and no other is asked; an index
    /// running is left to finish.
    pub cancel: Cancel,
    /// The directory of the per-project locks that keep two reviews from indexing one project at
    /// once.
    pub locks: PathBuf,
}

impl Cbm {
    #[must_use]
    pub fn new(tool: &str) -> Self {
        Self {
            tool: tool.to_owned(),
            timeout: TIMEOUT,
            budget: CALLERS_BUDGET,
            cancel: Cancel::default(),
            locks: scratch_locks(),
        }
    }

    /// This graph, its index locks kept under `dir` (`~/.craft/cbm-locks` for a review).
    #[must_use]
    pub fn locked_in(self, dir: &Path) -> Self {
        Self {
            locks: dir.to_path_buf(),
            ..self
        }
    }

    /// This graph, its questions stopped once `cancel` is.
    #[must_use]
    pub fn stopped_by(self, cancel: &Cancel) -> Self {
        Self {
            cancel: cancel.clone(),
            ..self
        }
    }

    /// The payload of `cli --quiet <name> <args + format json>`; why not, one line.
    fn call(&self, name: &str, mut args: Value, limit: Duration) -> Result<Value, CbmError> {
        if let Some(o) = args.as_object_mut() {
            o.insert("format".into(), "json".into());
        }
        let mut cmd = Command::new(&self.tool);
        cmd.args(["cli", "--quiet", name, &args.to_string()]);
        let (ok, stdout, stderr) = bounded(cmd, limit, &self.cancel)?;
        payload(name, ok, &stdout, &stderr)
    }
}

/// The payload of the tool `name`'s run that exited `ok` with `stdout` and `stderr`; why not,
/// one line.
pub(super) fn payload(name: &str, ok: bool, stdout: &str, stderr: &str) -> Result<Value, CbmError> {
    let payload: Option<Value> = serde_json::from_str(stdout.trim()).ok();
    let error = payload.as_ref().and_then(|p| p.get("error"));
    match (ok, payload.as_ref(), error) {
        (true, Some(p), None) => Ok(p.clone()),
        (_, _, Some(e)) => Err(CbmError::Graph(format!(
            "{name}: {}",
            e.as_str().map_or_else(|| e.to_string(), str::to_owned)
        ))),
        _ => Err(CbmError::Graph(format!(
            "{name}: {}",
            last_line(stderr, stdout)
        ))),
    }
}

/// What is left until `deadline`.
///
/// # Errors
/// [`CbmError::TimeBound`] once it has passed.
pub(super) fn left(deadline: Instant) -> Result<Duration, CbmError> {
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(CbmError::TimeBound);
    }
    Ok(left)
}

/// Whether `s` is an identifier, so it can be quoted into a query as it is.
pub(super) fn is_ident(s: &str) -> bool {
    let mut cs = s.chars();
    cs.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}
