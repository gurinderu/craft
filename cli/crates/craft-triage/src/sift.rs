//! Repeats inside one batch collapsed onto one finding before any validator, as
//! `integrations/shared/triage-sift.mjs` (realm @nick/craft, node #305); the memory's part of the
//! sift stays the review's (`craft-review`'s memory) and is not here.

use craft_review::ledger::overlap;

use crate::finding::{Finding, location_parts, severity_rank};
use crate::ledger::LedgerEntry;

/// How much two titles at one site must share to be one finding said twice.
pub const REPEAT_TITLE_OVERLAP: f64 = 0.6;
/// The lines apart two findings may sit and still be one site (`MATCH_SURE_WINDOW`).
pub const SURE_WINDOW: u64 = 3;
/// The mark every ledger row the sift settles carries in its reason.
pub const SIFT_MARK: &str = "SIFTED BEFORE VALIDATION";

/// A gathered finding as the sift reads it: its stable id, file and line.
#[derive(Debug, Clone, PartialEq, Eq)]
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
        let (file, line) = location_parts(&f.location);
        Self {
            finding: f,
            stable_id: id,
            file,
            line,
        }
    }
}

/// A repeat: the finding and the id it was collapsed onto.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repeat {
    pub finding: Sifted,
    pub of: String,
}

/// The batch with its repeats collapsed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Collapsed {
    pub kept: Vec<Sifted>,
    pub repeated: Vec<Repeat>,
}

/// Whether `b` says `a` again: the same review thread, or the same file, lines within the sure
/// window when both carry one, and titles sharing most of their words.
#[must_use]
pub fn repeats_finding(a: &Sifted, b: &Sifted) -> bool {
    if !a.finding.thread_id.is_empty() && a.finding.thread_id == b.finding.thread_id {
        return true;
    }
    if a.file.is_empty() || a.file != b.file {
        return false;
    }
    if a.line != 0 && b.line != 0 && a.line.abs_diff(b.line) > SURE_WINDOW {
        return false;
    }
    overlap(&a.finding.title, &b.finding.title) >= REPEAT_TITLE_OVERLAP
}

/// The batch with each repeat collapsed onto the most severe of them, so a repeat never lowers
/// what goes on; the same id twice is one finding gathered twice, kept once.
#[must_use]
pub fn collapse_repeats(findings: Vec<Sifted>) -> Collapsed {
    let mut out = Collapsed::default();
    let mut seen = std::collections::HashSet::new();
    for f in findings {
        if !seen.insert(f.stable_id.clone()) {
            continue;
        }
        let Some(at) = out.kept.iter().position(|k| repeats_finding(k, &f)) else {
            out.kept.push(f);
            continue;
        };
        let Some(twin) = out.kept.get_mut(at) else {
            continue;
        };
        if severity_rank(&f.finding.severity) >= severity_rank(&twin.finding.severity) {
            out.repeated.push(Repeat {
                finding: f,
                of: twin.stable_id.clone(),
            });
            continue;
        }
        let twin = std::mem::replace(twin, f);
        let now = out
            .kept
            .get(at)
            .map(|k| k.stable_id.clone())
            .unwrap_or_default();
        for r in &mut out.repeated {
            if r.of == twin.stable_id {
                r.of.clone_from(&now);
            }
        }
        out.repeated.push(Repeat {
            finding: twin,
            of: now,
        });
    }
    out
}

/// The ledger row of a repeat: `reject`, its twin alone judged, `repeat_of` naming the twin
/// (realm @nick/craft, node #312).
#[must_use]
pub fn repeat_entry(r: &Repeat) -> LedgerEntry {
    LedgerEntry {
        stable_id: r.finding.stable_id.clone(),
        verdict: "reject".into(),
        reason: format!(
            "{SIFT_MARK} — repeats {} in this batch (same site, same title words); judged there",
            r.of
        ),
        sifted: Some(true),
        action: None,
        repeat_of: Some(r.of.clone()),
    }
}

#[cfg(test)]
mod tests;
