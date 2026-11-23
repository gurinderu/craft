//! The review run's record a doubtful finding is posted from: which record, and what it says.

use std::path::{Path, PathBuf};

use anyhow::anyhow;
use craft_store::adapter::Env;
use craft_store::js::Obj;
use craft_store::posthoc::SortedRecordError;
use serde_json::Value;

use super::Stop;

/// The record named, else the newest of the repository carrying doubtful findings: refused when
/// none is found or it is another branch's, a failure when the request cannot be read.
pub(super) fn file(named: Option<&Path>, req: &Obj, env: &Env) -> Result<PathBuf, Stop> {
    craft_store::posthoc::sorted_record(named, req, env).map_err(|e| match e {
        SortedRecordError::Request(_) => Stop::Failed(anyhow!(e)),
        SortedRecordError::None { .. } | SortedRecordError::OtherBranch { .. } => {
            Stop::Refused(e.to_string())
        }
    })
}

/// What the record says of its doubtful findings and the review that held them back.
pub(super) struct Record {
    pub(super) findings: Vec<Value>,
    /// `sorting.inDiffJudged` is not false.
    pub(super) judged: bool,
    pub(super) head: Option<String>,
    pub(super) branch: Option<String>,
    /// The PR the run published on (`prComments.pr`), when it names one.
    pub(super) pr: Option<u64>,
    /// The review read uncommitted work (`dirty`).
    pub(super) dirty: bool,
}

pub(super) fn read(file: &Path) -> Result<Record, String> {
    let text =
        std::fs::read_to_string(file).map_err(|e| format!("reading {}: {e}", file.display()))?;
    let r: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", file.display()))?;
    let sorting = r.get("sorting").filter(|s| s.is_object());
    let findings = sorting
        .and_then(|s| s.get("findings"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|f| f.is_object()).cloned().collect())
        .unwrap_or_default();
    let text_of = |k: &str| r.get(k).and_then(Value::as_str).map(str::to_owned);
    Ok(Record {
        findings,
        judged: sorting.and_then(|s| s.get("inDiffJudged")) != Some(&Value::Bool(false)),
        head: text_of("head"),
        branch: text_of("branch"),
        pr: r
            .get("prComments")
            .and_then(|p| p.get("pr"))
            .and_then(Value::as_u64)
            .filter(|&n| n > 0),
        dirty: r.get("dirty") == Some(&Value::Bool(true)),
    })
}
