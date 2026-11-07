//! The recalled records and the launcher's own (`priorDecisions`) as one list, as `mergeRecall` in
//! `lib/memory-recall.mjs` merges them (realm @nick/craft, node #218): a passed record adds to the
//! recall, never replaces it — one whose id a well-formed recalled record holds is dropped, the
//! recalled one being the store's state — and the merged list is read once, under one cap, each
//! refusal naming its part.

use serde_json::Value;

use super::MemorySource;
use super::PriorDecision;
use super::oppose;
use super::recall::Recalled;
use super::record::{self, Parsed, plain_label};

/// What the merge applies: the records, every refusal, and the source as the report names it.
#[derive(Debug, Clone, Default)]
pub(super) struct Merged {
    pub decisions: Vec<PriorDecision>,
    pub refused: Vec<String>,
    pub source: MemorySource,
}

/// A record's id, and the one derived from its kind, title and scope (`heldIds`).
fn held_ids(x: &Value) -> Vec<String> {
    let Some(o) = x.as_object() else {
        return Vec::new();
    };
    [record::record_id(o), record::skill_record_id(o)]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect()
}

/// Whether a recalled record reads, its status aside: such a record holds its id even when the
/// store no longer keeps it active.
fn well_formed(x: &Value) -> bool {
    let mut x = x.clone();
    if let Some(o) = x.as_object_mut() {
        o.insert("status".into(), Value::Null);
    }
    record::read(&x, &plain_label(0)).is_ok()
}

/// The ids the applied records read from the recall hold.
fn recalled_ids(recalled: &[Value]) -> Vec<String> {
    recalled
        .iter()
        .filter_map(|x| record::read(x, &plain_label(0)).ok())
        .map(|d| d.id)
        .collect()
}

/// The source once the records are read: the recall's count is the records it applied, its
/// questions and rules among them counted apart (`acceptedMemory`).
fn accepted(m: MemorySource, applied: &[&PriorDecision]) -> MemorySource {
    if m.source == "none" {
        return m;
    }
    let of = |k| applied.iter().filter(|d| d.kind == k).count();
    let (q, r) = (of(super::RecordKind::Question), of(super::RecordKind::Rule));
    let mut out = MemorySource {
        count: applied.len(),
        ..MemorySource::none(m.why)
    };
    out.source = m.source;
    out.backend = m.backend;
    out.externals = m.externals;
    out.with_kinds(q, r, 0)
}

/// The passed records a well-formed recalled record does not already hold (`mergeById`).
fn fresh_at(recalled: &[Value], given: &[Value]) -> Vec<usize> {
    let held: Vec<String> = recalled
        .iter()
        .filter(|x| well_formed(x))
        .flat_map(held_ids)
        .collect();
    (0..given.len())
        .filter(|&i| {
            given
                .get(i)
                .is_some_and(|x| !held_ids(x).iter().any(|id| held.contains(id)))
        })
        .collect()
}

/// The recall's records merged with the launcher's `passed` list and read once.
pub(super) fn merge(r: Recalled, passed: Option<&Value>) -> Merged {
    let alone = record::parse(passed, &plain_label);
    let given: &[Value] = passed.and_then(Value::as_array).map_or(&[], Vec::as_slice);
    // A passed record the memory opposes is held back, or applied over it when newer (#224, #229).
    let block = oppose::blocked(given, &r.inactive, &fresh_at(&r.records, given), &r.records);
    let added_at: Vec<usize> = fresh_at(&r.records, given)
        .into_iter()
        .filter(|i| !block.at.contains(i))
        .collect();
    let recalled_len = r.records.len();
    let mut list: Vec<Value> = r
        .records
        .iter()
        .map(|x| oppose::without_links_to(x, &block.freed))
        .collect();
    list.extend(
        added_at
            .iter()
            .filter_map(|&i| Some(oppose::with_overrides(given.get(i)?, block.over.get(&i)))),
    );
    let label_of = |i: usize| match i.checked_sub(recalled_len) {
        None => format!("recalled decision #{i}"),
        Some(k) => format!("passed decision #{}", added_at.get(k).copied().unwrap_or(k)),
    };
    let Parsed { decisions, refused } = record::parse(Some(&Value::Array(list)), &label_of);
    let ids = recalled_ids(&r.records);
    let from_recall: Vec<&PriorDecision> =
        decisions.iter().filter(|d| ids.contains(&d.id)).collect();
    let mut source = accepted(r.source, &from_recall);
    if !alone.decisions.is_empty() {
        source.passed = Some(alone.decisions.len());
        source.added = Some(decisions.len() - from_recall.len());
    }
    let mut source = source.with_derived(&decisions);
    if !block.overrides.is_empty() {
        source.why = format!("{}; {}", source.why, block.overrides.join("; "));
    }
    let mut all_refused = if given.is_empty() && passed.is_some_and(|p| !p.is_array()) {
        alone.refused
    } else {
        Vec::new()
    };
    all_refused.extend(refused);
    all_refused.extend(block.refused);
    Merged {
        decisions,
        refused: all_refused,
        source,
    }
}

/// The launcher's records alone, before any recall (`readLaunch`): applied as passed, the source
/// not yet recalled.
pub(super) fn launch(passed: Option<&Value>) -> Merged {
    let Parsed { decisions, refused } = record::parse(passed, &plain_label);
    let mut source = MemorySource::default();
    if !decisions.is_empty() {
        source.passed = Some(decisions.len());
    }
    let source = source.with_derived(&decisions);
    Merged {
        decisions,
        refused,
        source,
    }
}
