//! One bucket's yield: its deduplicated findings, and the confirmed and suspected by severity.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::settle::Tier;

/// The severities a yield is split by, as `countBySeverity` does.
const SEVERITIES: [&str; 5] = ["Critical", "High", "Medium", "Low", "Info"];
/// The severities the round limit weighs (realm @nick/craft, node #248).
const MEDIUM_PLUS: [&str; 3] = ["Critical", "High", "Medium"];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Yield {
    #[serde(default)]
    pub unique: usize,
    /// By severity, an unknown one under its own name.
    #[serde(default)]
    pub confirmed: BTreeMap<String, usize>,
    #[serde(default)]
    pub suspected: BTreeMap<String, usize>,
}

fn total(m: &BTreeMap<String, usize>) -> usize {
    m.values().sum()
}

fn by_severity(m: &BTreeMap<String, usize>) -> Value {
    let o: Map<String, Value> = SEVERITIES
        .iter()
        .map(|s| ((*s).to_owned(), json!(m.get(*s).copied().unwrap_or(0))))
        .collect();
    Value::Object(o)
}

impl Yield {
    /// Counts `f` under `tier`, when it is confirmed or suspected.
    pub(super) fn add_tier(&mut self, tier: Tier, f: &Value) {
        let into = match tier {
            Tier::Confirmed => &mut self.confirmed,
            Tier::Suspected => &mut self.suspected,
            Tier::Refuted | Tier::Unverified => return,
        };
        let sev = f.get("severity").and_then(Value::as_str).unwrap_or("");
        *into.entry(sev.to_owned()).or_insert(0) += 1;
    }

    /// Every confirmed finding, whatever its severity.
    #[must_use]
    pub fn confirmed(&self) -> usize {
        total(&self.confirmed)
    }

    /// The yield as the record writes it: the deduplicated count under `unique`, then, when
    /// `verified`, the confirmed (all, Medium and above, by severity) and the suspected.
    pub(super) fn fields(&self, unique: &str, verified: bool) -> Map<String, Value> {
        let mut o = Map::new();
        o.insert(unique.into(), json!(self.unique));
        if verified {
            let plus: usize = MEDIUM_PLUS
                .iter()
                .filter_map(|s| self.confirmed.get(*s))
                .sum();
            o.insert("confirmed".into(), json!(self.confirmed()));
            o.insert("confirmedMediumPlus".into(), json!(plus));
            o.insert("confirmedBySeverity".into(), by_severity(&self.confirmed));
            o.insert("suspected".into(), json!(total(&self.suspected)));
            o.insert("suspectedBySeverity".into(), by_severity(&self.suspected));
        }
        o
    }
}
