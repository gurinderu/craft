//! Repeats inside one batch collapsed onto one finding before any validator, as
//! `integrations/shared/triage-sift.mjs` (realm @nick/craft, node #305).
//!
//! The memory's part of the sift stays the review's (`craft-review`'s memory) and is not here.

use craft_review::ledger::overlap;
pub use craft_review::memory::SURE_WINDOW;

use crate::finding::{Finding, location_parts, severity_rank};
use crate::json::Obj;
use crate::ledger::Row;

/// How much two titles at one site must share to be one finding said twice.
pub const REPEAT_TITLE_OVERLAP: f64 = 0.6;
/// The mark every ledger row the sift settles carries in its reason.
pub const SIFT_MARK: &str = "SIFTED BEFORE VALIDATION";

/// A gathered finding as the sift reads it: its stable id, file and line.
#[derive(Debug, Clone, PartialEq)]
pub struct Sifted {
    pub finding: Finding,
    pub stable_id: String,
    pub file: String,
    pub line: u64,
}

impl Sifted {
    /// `f` under the id `id`, its location read.
    #[must_use]
    pub fn new(f: Finding, id: String) -> Self {
        let (file, line) = location_parts(f.text("location"));
        Self {
            finding: f,
            stable_id: id,
            file,
            line,
        }
    }
}

/// A repeat: the finding and the id it was collapsed onto.
#[derive(Debug, Clone, PartialEq)]
pub struct Repeat {
    pub finding: Sifted,
    pub of: String,
}

/// The batch with its repeats collapsed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Collapsed {
    pub kept: Vec<Sifted>,
    pub repeated: Vec<Repeat>,
}

/// Whether `b` says `a` again: the same review thread, or the same file, lines within the sure
/// window when both carry one, and titles sharing most of their words.
#[must_use]
pub fn repeats_finding(a: &Sifted, b: &Sifted) -> bool {
    let thread = a.finding.text("thread_id");
    if !thread.is_empty() && thread == b.finding.text("thread_id") {
        return true;
    }
    if a.file.is_empty() || a.file != b.file {
        return false;
    }
    if a.line != 0 && b.line != 0 && a.line.abs_diff(b.line) > SURE_WINDOW {
        return false;
    }
    overlap(a.finding.text("title"), b.finding.text("title")) >= REPEAT_TITLE_OVERLAP
}

/// The batch with each repeat collapsed onto the most severe of them, so a repeat never lowers
/// what goes on (a tie keeps the one already kept); the same id twice is one finding gathered
/// twice, kept once.
#[must_use]
pub fn collapse_repeats(findings: Vec<Sifted>) -> Collapsed {
    let (mut kept, mut repeated): (Vec<Sifted>, Vec<Repeat>) = (Vec::new(), Vec::new());
    let mut seen = std::collections::HashSet::new();
    for f in findings {
        if !seen.insert(f.stable_id.clone()) {
            continue;
        }
        let Some(twin) = kept.iter_mut().find(|k| repeats_finding(k, &f)) else {
            kept.push(f);
            continue;
        };
        if severity_rank(f.finding.text("severity")) >= severity_rank(twin.finding.text("severity"))
        {
            let of = twin.stable_id.clone();
            repeated.push(Repeat { finding: f, of });
            continue;
        }
        let now = f.stable_id.clone();
        let twin = std::mem::replace(twin, f);
        for r in repeated.iter_mut().filter(|r| r.of == twin.stable_id) {
            r.of.clone_from(&now);
        }
        repeated.push(Repeat {
            finding: twin,
            of: now,
        });
    }
    Collapsed { kept, repeated }
}

/// The ledger row of a repeat, in `repeatEntry`'s order: `reject`, its twin alone judged,
/// `repeat_of` naming the twin (realm @nick/craft, node #312).
#[must_use]
pub fn repeat_entry(r: &Repeat) -> Row {
    let reason = format!(
        "{SIFT_MARK} — repeats {} in this batch (same site, same title words); judged there",
        r.of
    );
    Row(Obj::new()
        .with("stable_id", r.finding.stable_id.as_str())
        .with("verdict", "reject")
        .with("sifted", true)
        .with("repeat_of", r.of.as_str())
        .with("reason", reason))
}

#[cfg(test)]
mod tests;
