//! The run record triage-findings files, of the same form the JavaScript engine writes (realm
//! @nick/craft, node #616): the findings triaged and their severity mix, each source's count, the
//! verdicts tallied over the final ledger, what the sift settled, the memory, and what did not run.

use serde_json::{Map, Value, json};

use crate::finding::{Finding, Gathered, SEVERITIES};
use crate::ledger::LedgerEntry;

/// The verdicts a ledger is tallied by.
pub const VERDICTS: [&str; 5] = ["accept", "reject", "defer", "needs-decision", "conflict"];

/// What the record is made from.
#[derive(Debug, Clone, Default)]
pub struct RecordInput<'a> {
    pub craft_version: &'a str,
    pub gathered: &'a [Gathered],
    pub raw: &'a [Finding],
    pub validated: usize,
    pub ledger: &'a [LedgerEntry],
    /// How many repeats collapsed, and the memory sift's own counts in its order
    /// (`rejectedBefore`, `deferred`, `covered`, `conflict`, `reraised`).
    pub repeats: usize,
    pub sift_counts: Map<String, Value>,
    pub issues: usize,
    /// The memory as the record carries it (`memoryRecord`).
    pub memory: Value,
    pub not_run_sources: &'a [String],
    pub unjudged: usize,
}

/// The findings' total and severity mix, an unknown severity uncounted (`summarizeFindings`).
#[must_use]
pub fn summarize(raw: &[Finding]) -> Value {
    let by: Map<String, Value> = SEVERITIES
        .iter()
        .map(|s| {
            (
                (*s).to_owned(),
                json!(raw.iter().filter(|f| f.severity == *s).count()),
            )
        })
        .collect();
    let total: u64 = by.values().filter_map(Value::as_u64).sum();
    json!({ "total": total, "bySeverity": by })
}

/// The ledger's verdicts counted, an unknown one uncounted (`tallyVerdicts`).
#[must_use]
pub fn tally(ledger: &[LedgerEntry]) -> Map<String, Value> {
    VERDICTS
        .iter()
        .map(|v| {
            (
                (*v).to_owned(),
                json!(ledger.iter().filter(|e| e.verdict == *v).count()),
            )
        })
        .collect()
}

/// The run record.
#[must_use]
pub fn run_record(r: &RecordInput<'_>) -> Value {
    let sources: Vec<Value> = r
        .gathered
        .iter()
        .map(|g| json!({ "source": g.source, "count": g.findings.len() }))
        .collect();
    let mut sifted = Map::new();
    sifted.insert("repeats".into(), json!(r.repeats));
    sifted.extend(r.sift_counts.clone());
    let mut triage = Map::new();
    triage.insert("gathered".into(), json!(r.raw.len()));
    triage.insert("validated".into(), json!(r.validated));
    triage.extend(tally(r.ledger));
    triage.insert("sifted".into(), Value::Object(sifted));
    triage.insert("issues".into(), json!(r.issues));
    let mut not_run: Vec<String> = r
        .not_run_sources
        .iter()
        .map(|s| format!("gather:{s}"))
        .collect();
    if r.unjudged > 0 {
        not_run.push("findings-unjudged".into());
    }
    json!({
        "schemaVersion": 1,
        "runtime": "claude-code",
        "craftVersion": r.craft_version,
        "kind": "workflow",
        "name": "triage-findings",
        "verdict": "",
        "findings": summarize(r.raw),
        "nested": false,
        "via": null,
        "sources": sources,
        "triage": triage,
        "memory": r.memory,
        "notRun": not_run,
    })
}

#[cfg(test)]
mod tests;
