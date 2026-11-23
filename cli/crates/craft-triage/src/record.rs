//! The run record triage-findings files, key for key in the order the JavaScript engine hands it
//! to the logger (realm @nick/craft, node #616).
//!
//! It holds the findings triaged and their severity mix, each source's count, the verdicts
//! tallied over the final ledger, what the sift settled, the memory, and what did not run.

use craft_store::js::{Js, Obj};

use crate::field::{self, num};
use crate::finding::{Finding, Gathered, SEVERITIES};

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
#[derive(Debug, Clone)]
pub struct RecordInput<'a> {
    pub craft_version: &'a str,
    pub gathered: &'a [Gathered],
    pub raw: &'a [Finding],
    pub validated: usize,
    pub ledger: &'a [Js],
    /// How many repeats collapsed.
    pub repeats: usize,
    pub sift_counts: SiftCounts,
    pub issues: usize,
    /// The memory as the record carries it (`memoryRecord`), its keys in that order.
    pub memory: Js,
    pub not_run_sources: &'a [String],
    pub unjudged: usize,
}

/// How many of `items` are the text `want`.
fn count<'a>(items: impl Iterator<Item = Option<&'a Js>>, want: &str) -> usize {
    items
        .filter(|v| v.and_then(Js::as_str) == Some(want))
        .count()
}

/// The findings' total and severity mix, an unknown severity uncounted (`summarizeFindings`).
#[must_use]
pub fn summarize(raw: &[Finding]) -> Js {
    let mut by = Obj::new();
    let mut total = 0;
    for s in SEVERITIES {
        let n = count(raw.iter().map(|f| f.0.get("severity")), s);
        total += n;
        by.set(s, num(n));
    }
    Js::Obj(
        Obj::new()
            .with("total", num(total))
            .with("bySeverity", Js::Obj(by)),
    )
}

/// The ledger's verdicts counted, an unknown one uncounted (`tallyVerdicts`).
#[must_use]
pub fn tally(ledger: &[Js]) -> Obj {
    let mut t = Obj::new();
    for v in VERDICTS {
        t.set(
            v,
            num(count(
                ledger
                    .iter()
                    .map(|e| e.as_obj().and_then(|o| o.get("verdict"))),
                v,
            )),
        );
    }
    t
}

/// The record's `triage` part.
fn triage(r: &RecordInput<'_>) -> Obj {
    let c = r.sift_counts;
    let sifted = Obj::new()
        .with("repeats", num(r.repeats))
        .with("rejectedBefore", num(c.rejected_before))
        .with("deferred", num(c.deferred))
        .with("covered", num(c.covered))
        .with("conflict", num(c.conflict))
        .with("reraised", num(c.reraised));
    let mut t = Obj::new()
        .with("gathered", num(r.raw.len()))
        .with("validated", num(r.validated));
    for (k, v) in tally(r.ledger).iter() {
        t.set(k, v.clone());
    }
    t.with("sifted", Js::Obj(sifted))
        .with("issues", num(r.issues))
}

/// The run record.
#[must_use]
pub fn run_record(r: &RecordInput<'_>) -> Js {
    let sources: Vec<Js> = r
        .gathered
        .iter()
        .map(|g| {
            Js::Obj(
                Obj::new()
                    .with("source", Js::str(g.source.as_str()))
                    .with("count", num(g.findings.len())),
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
        .with("schemaVersion", num(1))
        .with("runtime", Js::str("claude-code"))
        .with("craftVersion", Js::str(r.craft_version))
        .with("kind", Js::str("workflow"))
        .with("name", Js::str("triage-findings"))
        .with("verdict", Js::str(""))
        .with("findings", summarize(r.raw))
        .with("nested", Js::Bool(false))
        .with("via", Js::Null)
        .with("sources", Js::Arr(sources))
        .with("triage", Js::Obj(triage(r)))
        .with("memory", r.memory.clone())
        .with("notRun", field::texts(&not_run));
    Js::Obj(o)
}

#[cfg(test)]
mod tests;
