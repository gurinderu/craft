//! What each lens round yielded once the pool was deduplicated and verified (realm @nick/craft,
//! node #248), by the origin a finding carries ([`crate::dedup::with_rounds`]): a lens round's
//! findings by the earliest lens round that raised them, on the record's `lensRounds` rows; the
//! gate's seeds apart (`seedYield`); extras, seams, the critic's and the rest by origin
//! (`unattributedYield`), their confirmed summed as `unattributedConfirmed`, so the rounds, the
//! seeds and they add up to every confirmed finding. Counted only, never steering the rounds.

mod yields;

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::Tally;
use crate::dedup::{GATE, LENS};
use crate::settle::Tier;
use crate::state::RunState;
pub use yields::Yield;

/// Each bucket's yield: the lens rounds, the seeds and the other origins.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByRound {
    #[serde(default)]
    pub rounds: BTreeMap<u32, Yield>,
    #[serde(default)]
    pub seeds: Yield,
    #[serde(default)]
    pub other: BTreeMap<String, Yield>,
    /// Whether a verification pass settled, so the tiers are counted.
    #[serde(default)]
    pub verified: bool,
}

impl ByRound {
    /// The bucket `f` counts in, by its origin.
    fn bucket(&mut self, f: &Value) -> &mut Yield {
        let origin = f.get("foundBy").and_then(Value::as_str).unwrap_or("");
        let round = f
            .get("lensRound")
            .and_then(Value::as_u64)
            .and_then(|r| u32::try_from(r).ok());
        match (origin, round) {
            (GATE, _) => &mut self.seeds,
            (LENS, Some(r)) => self.rounds.entry(r).or_default(),
            ("", _) => self.other.entry("other".into()).or_default(),
            (o, _) => self.other.entry(o.to_owned()).or_default(),
        }
    }
}

impl Tally {
    /// Counts the pool the dedup left, as it goes to verification.
    pub(crate) fn deduped(&mut self, findings: &[Value]) {
        let by = self.by_round.get_or_insert_with(ByRound::default);
        for f in findings {
            by.bucket(f).unique += 1;
        }
    }

    /// Counts the confirmed and suspected among `settled` once a verification pass settled them.
    pub(crate) fn tiers(&mut self, settled: &[Value]) {
        let Some(by) = self.by_round.as_mut() else {
            return;
        };
        by.verified = true;
        for f in settled {
            let tier = Tier::of(f);
            by.bucket(f).add_tier(tier, f);
        }
    }

    /// A pool the rounds left empty: nothing to deduplicate and nothing to verify in any bucket.
    pub(crate) fn nothing_pooled(&mut self) {
        self.by_round.get_or_insert_with(ByRound::default).verified = true;
    }
}

/// The record's `lensRounds`: each round as the rounds kept it, with its yield once the dedup
/// counted (its tiers once a verification pass settled).
#[must_use]
pub fn lens_rounds(run: &RunState) -> Vec<Value> {
    let by = run.telemetry.by_round.as_ref();
    run.rounds
        .yields
        .iter()
        .map(|y| {
            let mut row = serde_json::to_value(y).unwrap_or_else(|_| json!({}));
            if let (Some(by), Some(obj)) = (by, row.as_object_mut()) {
                let at = by.rounds.get(&y.round).cloned().unwrap_or_default();
                obj.extend(at.fields("newUnique", by.verified));
            }
            row
        })
        .collect()
}

/// The record's fields beside `lensRounds`: `seedYield`, `unattributedYield` and, once verified,
/// `unattributedConfirmed`; none before the dedup counted.
#[must_use]
pub fn apart(run: &RunState) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(by) = run.telemetry.by_round.as_ref() else {
        return out;
    };
    let obj = |y: &Yield| Value::Object(y.fields("unique", by.verified));
    out.insert("seedYield".into(), obj(&by.seeds));
    let other: Map<String, Value> = by.other.iter().map(|(k, y)| (k.clone(), obj(y))).collect();
    out.insert("unattributedYield".into(), Value::Object(other));
    if by.verified {
        let confirmed: usize = by.other.values().map(Yield::confirmed).sum();
        out.insert("unattributedConfirmed".into(), json!(confirmed));
    }
    out
}

#[cfg(test)]
mod tests;
