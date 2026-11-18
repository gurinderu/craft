//! The run store's records as this check reads them: an `index.jsonl` line, and the scope a run's
//! detail file beside it says, `<ts>-<kind>-<name>.json` as `recordFilename` in
//! `lib/craft-log-run.mjs` names it.

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use super::runs::Scope;

/// An index line, only the fields this reads.
#[derive(Deserialize)]
pub struct Line {
    #[serde(default)]
    pub ts: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub head: Option<String>,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub nested: Option<bool>,
}

/// The run's scope from its detail file; a partial record counts as not full.
pub fn scope_of(store: &Path, line: &Line) -> Scope {
    let file = store.join(record_filename(line));
    let Some(record) = std::fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
    else {
        return Scope::Unknown;
    };
    let partial = record
        .get("partial")
        .is_some_and(|p| p.as_bool() == Some(true));
    match record.get("lensScope").and_then(Value::as_str) {
        _ if partial => Scope::Unknown,
        Some("delta") => Scope::Delta,
        _ => Scope::Full,
    }
}

/// `recordFilename` in `lib/craft-log-run.mjs`.
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
