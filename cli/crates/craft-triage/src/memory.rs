//! The memory's part of the sift, as `siftByMemory` in `integrations/shared/triage-sift.mjs` runs
//! it (realm @nick/craft, nodes #305, #309, #616): the batch's kept findings split by the records
//! the review's memory holds — the decisions first, the match judge asked about their pairs, then
//! the project rules, the rule judges asked about the findings in their scope — each mark appended
//! to the finding's `memoryNote`. What a record answers leaves for the ledger without a validator;
//! a finding a judge shows going against a record is a `conflict` for a human; the rest go on to
//! their validators, a raised one with its note.

mod record;
mod value;

use craft_review::memory::{Applied, Covered, contradiction_of};
use craft_store::js::{Js, JsString, Obj, is_space_unit};
use serde_json::Value;

use crate::field;
use crate::ledger::Row;
use crate::record::SiftCounts;
use crate::sift::{SIFT_MARK, Sifted};

pub use record::memory_record;
pub use value::as_values;

/// The field of a gathered finding the memory's marks and notes are appended to.
pub const NOTE: &str = "memoryNote";
/// Why a batch whose findings name no file asks no recall: only the launcher's records apply.
pub const NOT_RECALLED: &str = "not recalled — no gathered finding names a file";

/// The files the recall is asked about: each kept finding's, once, in the batch's order.
#[must_use]
pub fn recall_paths(kept: &[Sifted]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for f in kept.iter().map(|s| s.file.to_utf8_lossy()) {
        if !f.is_empty() && !paths.contains(&f) {
            paths.push(f);
        }
    }
    paths
}

/// The batch once the memory sifted it: the findings left for the validators, the ledger rows of
/// everything it settled, and what the plan and the run record say of it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Settled {
    pub to_validate: Vec<Sifted>,
    pub ledger: Vec<Row>,
    pub notes: Vec<String>,
    pub notices: Vec<String>,
    pub refused: Vec<String>,
    pub counts: SiftCounts,
}

/// The batch `kept` settled by what the decisions did (`decided`, its kept findings already handed
/// to the rules) and what the rules did with them (`ruled`).
#[must_use]
pub fn settled(kept: &[Sifted], decided: Applied, ruled: Covered) -> Settled {
    let of = |f: &Value| value::sifted_of(kept, f);
    let question = |f: &&Value| f.get("priorKind").and_then(Value::as_str) == Some("question");
    let deferred = decided.set_aside.iter().filter(question).count();
    let (conflicts, left): (Vec<&Value>, Vec<&Value>) = ruled
        .kept
        .iter()
        .partition(|f| contradiction_of(f).is_some());
    let aside = decided.set_aside.iter().chain(&ruled.covered);
    let mut ledger: Vec<Row> = aside
        .filter_map(|f| Some(set_aside_entry(&of(f)?, f)))
        .collect();
    ledger.extend(
        conflicts
            .iter()
            .filter_map(|f| Some(conflict_entry(&of(f)?, f))),
    );
    Settled {
        to_validate: left.into_iter().filter_map(of).collect(),
        ledger,
        notes: decided.notes.into_iter().chain(ruled.notes).collect(),
        notices: ruled.notices,
        refused: decided.refused,
        counts: SiftCounts {
            rejected_before: decided.set_aside.len() - deferred,
            deferred,
            covered: ruled.covered.len(),
            conflict: conflicts.len(),
            reraised: decided.reraised,
        },
    }
}

/// The `·` a note's marks are joined by.
const MIDDLE_DOT: u16 = 0xb7;

/// A mark as the ledger's reason carries it: its leading ` · ` cut (`replace(/^\s*·\s*/, '')`).
pub(crate) fn mark(note: &JsString) -> JsString {
    let mut units = note.units().skip_while(|u| is_space_unit(*u)).peekable();
    if units.next_if_eq(&MIDDLE_DOT).is_none() {
        return note.clone();
    }
    JsString::from_utf16(units.skip_while(|u| is_space_unit(*u)).collect())
}

fn text(f: &Value, key: &str) -> String {
    f.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

/// The ledger row of a finding a record set aside (`setAsideEntry`): a deferred question's is
/// `defer`, a decision's or a rule's `reject`, its reason the record's mark and how it matched.
fn set_aside_entry(s: &Sifted, f: &Value) -> Row {
    let verdict = if text(f, "priorKind") == "question" {
        "defer"
    } else {
        "reject"
    };
    let reason = field::cat(&[
        format!("{SIFT_MARK} — ").into(),
        mark(&s.memory_note),
        format!(" · {}", text(f, "priorMatch")).into(),
    ]);
    entry(s, verdict, reason)
}

/// The ledger row of a finding going against a record (`conflictEntry`).
fn conflict_entry(s: &Sifted, f: &Value) -> Row {
    let (id, kind, why) = contradiction_of(f).unwrap_or_default();
    let reason = format!(
        "{SIFT_MARK} — goes against {kind} {id} in project memory ({why}); a human decides whether the record still stands"
    );
    entry(s, "conflict", reason.into())
}

fn entry(s: &Sifted, verdict: &str, reason: JsString) -> Row {
    Row(Obj::new()
        .with("stable_id", Js::Str(s.stable_id.clone()))
        .with("verdict", Js::str(verdict))
        .with("sifted", Js::Bool(true))
        .with("reason", Js::Str(reason)))
}

#[cfg(test)]
mod tests;
