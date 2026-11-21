//! The run store's records as this check reads them: an `index.jsonl` line, and the detail file
//! beside it, `<ts>-<kind>-<name>.json` as `recordFilename` in `integrations/shared/craft-log-run.mjs` names it.
//! Only the fields the check reads; a detail file that does not parse in this shape is unread.

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

/// An index line.
#[derive(Deserialize)]
pub struct Line {
    pub ts: Option<String>,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub project: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub verdict: Option<String>,
    pub nested: Option<bool>,
    /// Whether tracked files differed from the head when the run read it.
    pub dirty: Option<bool>,
}

/// A CLI review's detail file (`integrations/shared/cli-review-record.mjs`).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Detail {
    /// Recovered from checkpoints, never finished.
    pub partial: Option<bool>,
    /// `delta` for a round over the fix commits alone.
    pub lens_scope: Option<String>,
    /// `light` for a light pass.
    pub depth: Option<String>,
    /// The directory the review was confined to (`path=`); none or empty for the whole change.
    pub path: Option<String>,
    /// The ref the change was measured against.
    pub base: Option<String>,
    pub not_run: Option<Vec<Value>>,
    /// One entry per lens round; none when the run ended before its lenses (a red gate).
    pub lens_rounds: Option<Vec<Value>>,
}

/// The detail file of the run `line` names, `None` when it is missing or unreadable.
pub fn detail(store: &Path, line: &Line) -> Option<Detail> {
    let bytes = std::fs::read(store.join(record_filename(line))).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// `recordFilename` in `integrations/shared/craft-log-run.mjs`.
fn record_filename(line: &Line) -> String {
    let safe = |s: Option<&str>| -> String {
        s.unwrap_or("unknown")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                    c
                } else {
                    '-'
                }
            })
            .collect()
    };
    let (ts, kind, name) = (
        line.ts.as_deref(),
        line.kind.as_deref(),
        line.name.as_deref(),
    );
    format!("{}-{}-{}.json", safe(ts), safe(kind), safe(name))
}
