//! The run record triage-findings files, key for key in the order the JavaScript engine hands it
//! to the logger (realm @nick/craft, node #616).
//!
//! It holds the findings triaged and their severity mix, each source's count, the verdicts
//! tallied over the final ledger, what the sift settled, the memory, and what did not run.

use crate::finding::{Finding, Gathered, SEVERITIES};
use crate::json::{Json, Obj};

/// The verdicts a ledger is tallied by, in `tallyVerdicts`' order.
pub const VERDICTS: [&str; 5] = ["accept", "reject", "defer", "needs-decision", "conflict"];

/// The memory sift's own counts (`siftByMemory`'s `counts`), in its order.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SiftCounts {
    pub rejected_before: usize,
    pub deferred: usize,
    pub covered: usize,
    pub conflict: usize,
    pub reraised: usize,
}

/// What the record is made from.
#[derive(Debug, Clone, Default)]
pub struct RecordInput<'a> {
    pub craft_version: &'a str,
    pub gathered: &'a [Gathered],
    pub raw: &'a [Finding],
    pub validated: usize,
    pub ledger: &'a [Json],
    /// How many repeats collapsed.
    pub repeats: usize,
    pub sift_counts: SiftCounts,
    pub issues: usize,
    /// The memory as the record carries it (`memoryRecord`), its keys in that order.
    pub memory: Json,
    pub not_run_sources: &'a [String],
    pub unjudged: usize,
}

/// How many of `items` have the text `want` under `key`.
fn count(items: impl Iterator<Item = Option<Json>>, want: &str) -> usize {
    items
        .filter(|v| v.as_ref().and_then(Json::as_str) == Some(want))
        .count()
}

/// The findings' total and severity mix, an unknown severity uncounted (`summarizeFindings`).
#[must_use]
pub fn summarize(raw: &[Finding]) -> Json {
    let mut by = Obj::new();
    let mut total = 0;
    for s in SEVERITIES {
        let n = count(raw.iter().map(|f| f.0.get("severity").cloned()), s);
        total += n;
        by.set(s, n);
    }
    Json::Object(Obj::new().with("total", total).with("bySeverity", by))
}

/// The ledger's verdicts counted, an unknown one uncounted (`tallyVerdicts`).
#[must_use]
pub fn tally(ledger: &[Json]) -> Obj {
    let mut t = Obj::new();
    for v in VERDICTS {
        t.set(
            v,
            count(
                ledger
                    .iter()
                    .map(|e| e.as_object().and_then(|o| o.get("verdict")).cloned()),
                v,
            ),
        );
    }
    t
}

/// The record's `triage` part.
fn triage(r: &RecordInput<'_>) -> Obj {
    let c = r.sift_counts;
    let sifted = Obj::new()
        .with("repeats", r.repeats)
        .with("rejectedBefore", c.rejected_before)
        .with("deferred", c.deferred)
        .with("covered", c.covered)
        .with("conflict", c.conflict)
        .with("reraised", c.reraised);
    let mut t = Obj::new()
        .with("gathered", r.raw.len())
        .with("validated", r.validated);
    for (k, v) in tally(r.ledger) {
        t.set(&k, v);
    }
    t.with("sifted", sifted).with("issues", r.issues)
}

/// The run record.
#[must_use]
pub fn run_record(r: &RecordInput<'_>) -> Json {
    let sources: Vec<Json> = r
        .gathered
        .iter()
        .map(|g| {
            Json::Object(
                Obj::new()
                    .with("source", g.source.as_str())
                    .with("count", g.findings.len()),
            )
        })
        .collect();
    let mut not_run: Vec<String> = r
        .not_run_sources
        .iter()
        .map(|s| format!("gather:{s}"))
        .collect();
    if r.unjudged > 0 {
        not_run.push("findings-unjudged".into());
    }
    let o = Obj::new()
        .with("schemaVersion", 1usize)
        .with("runtime", "claude-code")
        .with("craftVersion", r.craft_version)
        .with("kind", "workflow")
        .with("name", "triage-findings")
        .with("verdict", "")
        .with("findings", summarize(r.raw))
        .with("nested", false)
        .with("via", Json::Null)
        .with("sources", sources)
        .with("triage", triage(r))
        .with("memory", r.memory.clone())
        .with("notRun", not_run);
    Json::Object(o)
}

#[cfg(test)]
mod tests;
