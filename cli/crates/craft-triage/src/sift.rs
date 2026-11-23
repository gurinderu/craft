//! Repeats inside one batch collapsed onto one finding before any validator, as
//! `integrations/shared/triage-sift.mjs` (realm @nick/craft, node #305).
//!
//! The memory's part of the sift stays the review's (`craft-review`'s memory) and is not here.

use craft_review::ledger::overlap;
pub use craft_review::memory::SURE_WINDOW;

use crate::field;
use crate::finding::{Finding, location_parts, severity_rank};
use crate::ledger::Row;
use craft_store::js::{Js, JsString, Obj, is_space_unit};

/// How much two titles at one site must share to be one finding said twice.
pub const REPEAT_TITLE_OVERLAP: f64 = 0.6;
/// The mark every ledger row the sift settles carries in its reason.
pub const SIFT_MARK: &str = "SIFTED BEFORE VALIDATION";

/// A gathered finding as the sift reads it: its stable id, file and line, the file in its own
/// code units.
#[derive(Debug, Clone, PartialEq)]
pub struct Sifted {
    pub finding: Finding,
    pub stable_id: JsString,
    pub file: JsString,
    pub line: u64,
}

impl Sifted {
    /// `f` under the id `id`, its location read. The location is read as UTF-8, where an
    /// unpaired surrogate is U+FFFD — one code unit for one, and neither whitespace nor a digit
    /// nor `:` — so the file is the same span of the location's own code units.
    #[must_use]
    pub fn new(f: Finding, id: JsString) -> Self {
        let location = f.0.text_units("location");
        let (file, line) = location_parts(&location.to_utf8_lossy());
        let lead = location.units().take_while(|u| is_space_unit(*u)).count();
        let span = file.encode_utf16().count();
        let file = JsString::from_utf16(location.units().skip(lead).take(span).collect());
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
    pub of: JsString,
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
    let thread = a.finding.0.text_units("thread_id");
    if !thread.is_empty() && thread == b.finding.0.text_units("thread_id") {
        return true;
    }
    if a.file.is_empty() || a.file != b.file {
        return false;
    }
    if a.line != 0 && b.line != 0 && a.line.abs_diff(b.line) > SURE_WINDOW {
        return false;
    }
    overlap(&a.finding.text("title"), &b.finding.text("title")) >= REPEAT_TITLE_OVERLAP
}

/// The batch with each repeat collapsed onto the most severe of them, so a repeat never lowers
/// what goes on (a tie keeps the one already kept); the same id twice is one finding gathered
/// twice, kept once.
#[must_use]
pub fn collapse_repeats(findings: Vec<Sifted>) -> Collapsed {
    let (mut kept, mut repeated): (Vec<Sifted>, Vec<Repeat>) = (Vec::new(), Vec::new());
    let mut seen = std::collections::BTreeSet::new();
    for f in findings {
        if !seen.insert(f.stable_id.clone()) {
            continue;
        }
        let Some(twin) = kept.iter_mut().find(|k| repeats_finding(k, &f)) else {
            kept.push(f);
            continue;
        };
        if severity_rank(&f.finding.text("severity"))
            >= severity_rank(&twin.finding.text("severity"))
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
    let reason = field::cat(&[
        format!("{SIFT_MARK} — repeats ").into(),
        r.of.clone(),
        " in this batch (same site, same title words); judged there".into(),
    ]);
    Row(Obj::new()
        .with("stable_id", Js::Str(r.finding.stable_id.clone()))
        .with("verdict", Js::str("reject"))
        .with("sifted", Js::Bool(true))
        .with("repeat_of", Js::Str(r.of.clone()))
        .with("reason", Js::Str(reason)))
}

#[cfg(test)]
mod tests;
