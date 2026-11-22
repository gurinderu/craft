//! What each lens round yielded once the pool was deduplicated and verified, by the round that
//! first raised a finding (`foundInRound`, [`crate::dedup::with_rounds`]): the record's
//! `lensRounds` rows carry it beside what each round dispatched and added, so a low-yield round
//! can be told from a productive one. Counted only, never steering how many rounds run.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Tally;
use crate::settle::Tier;
use crate::state::RunState;

/// The deduplicated findings and the confirmed ones, each by the round that first raised it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByRound {
    /// Unique after the dedup, by earliest round.
    #[serde(default)]
    pub unique: BTreeMap<u32, usize>,
    /// Confirmed by verification, by earliest round; `None` until a verification pass settled.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<BTreeMap<u32, usize>>,
}

/// The round that first raised `f`, when a lens round did.
fn round_of(f: &Value) -> Option<u32> {
    f.get("foundInRound")
        .and_then(Value::as_u64)
        .and_then(|r| u32::try_from(r).ok())
}

fn add(into: &mut BTreeMap<u32, usize>, findings: impl Iterator<Item = u32>) {
    for r in findings {
        *into.entry(r).or_insert(0) += 1;
    }
}

impl Tally {
    /// Counts the pool the dedup left, as it goes to verification.
    pub(crate) fn deduped(&mut self, findings: &[Value]) {
        let by = self.by_round.get_or_insert_with(ByRound::default);
        add(&mut by.unique, findings.iter().filter_map(round_of));
    }

    /// Counts the confirmed among `settled` once a verification pass settled them.
    pub(crate) fn confirmed(&mut self, settled: &[Value]) {
        let Some(by) = self.by_round.as_mut() else {
            return;
        };
        let confirmed = settled
            .iter()
            .filter(|f| Tier::of(f) == Tier::Confirmed)
            .filter_map(round_of);
        add(by.confirmed.get_or_insert_with(BTreeMap::new), confirmed);
    }

    /// A pool the rounds left empty: nothing to deduplicate and nothing to confirm in any round.
    pub(crate) fn nothing_pooled(&mut self) {
        self.by_round = Some(ByRound {
            unique: BTreeMap::new(),
            confirmed: Some(BTreeMap::new()),
        });
    }
}

/// The record's `lensRounds`: each round as the rounds kept it, with `newUnique` (deduplicated
/// findings it raised first) once the dedup counted, and `confirmed` (those verification
/// confirmed) once a verification pass settled.
#[must_use]
pub fn lens_rounds(run: &RunState) -> Vec<Value> {
    let by = run.telemetry.by_round.as_ref();
    run.rounds
        .yields
        .iter()
        .map(|y| {
            let mut row = serde_json::to_value(y).unwrap_or_else(|_| json!({}));
            if let (Some(by), Some(obj)) = (by, row.as_object_mut()) {
                let at = |m: &BTreeMap<u32, usize>| json!(m.get(&y.round).copied().unwrap_or(0));
                obj.insert("newUnique".into(), at(&by.unique));
                if let Some(c) = &by.confirmed {
                    obj.insert("confirmed".into(), at(c));
                }
            }
            row
        })
        .collect()
}

#[cfg(test)]
mod tests;
