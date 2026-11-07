//! This round's lens findings reconciled with the prior round, as `reconcilePhase` in
//! `lib/review-reconcile-priors.mjs` does: one repeating a still-live prior is absorbed into it,
//! one matching a tombstone is marked as a defect that came back.

use serde_json::Value;

use super::Chain;
use super::judge::field;
use crate::ledger;

/// The round's pool reconciled with the prior round: a finding repeating a still-live prior leaves
/// the pool (the prior carries it, and is not reported twice), and one matching a tombstone is
/// marked as having come back. Returns the notes of what it did.
pub fn absorb(chain: &mut Chain, pool: &mut Vec<Value>) -> Vec<String> {
    if chain.prior.is_none() {
        return Vec::new();
    }
    let hosts: Vec<Value> = chain
        .priors
        .iter()
        .filter(|p| p.live())
        .map(|p| p.row.finding())
        .collect();
    let before = pool.len();
    pool.retain(|f| !hosts.iter().any(|h| ledger::repeats(f, h)));
    chain.absorbed = before - pool.len();
    for f in pool.iter_mut() {
        let Some(t) = chain
            .tombstones
            .iter()
            .rev()
            .find(|t| ledger::returns_as(f, t))
        else {
            continue;
        };
        let round = t.why.split("round ").nth(1).unwrap_or("?").to_owned();
        let why = format!(
            "{} REGRESSION: this exact defect was resolved in round {round} and has reappeared.",
            field(f, "why")
        );
        if let Some(obj) = f.as_object_mut() {
            obj.insert("why".into(), Value::String(why));
            chain.regressions += 1;
        }
    }
    let mut notes = Vec::new();
    if chain.absorbed > 0 {
        notes.push(format!("re-review: {} lens finding(s) repeated a prior finding still tracked at the same file and rule, and were absorbed into it rather than reported twice", chain.absorbed));
    }
    if chain.regressions > 0 {
        notes.push(format!("re-review: {} finding(s) match a defect an earlier round resolved, marked REGRESSION; each still counts by its severity", chain.regressions));
    }
    notes
}
