//! What a run carries to its branch's next round: its ledger.

use serde_json::Value;

use super::absorb::LEDGER_DUP;
use super::{Chain, Fate};
use crate::ledger::LedgerRow;
use crate::report::Tier;

/// How many tombstones a ledger keeps, the newest ones: a forgotten one only turns a regression
/// into a plain new finding.
pub(super) const TOMBSTONES_MAX: usize = 100;

/// The ledger the run leaves for its next round, from its settled findings: every reported one
/// open, the priors as they fared (a resolved one as a tombstone of this round), the carried
/// tombstones, newest kept.
#[must_use]
pub fn ledger(chain: &Chain, settled: &[Value]) -> Vec<LedgerRow> {
    let mut rows: Vec<LedgerRow> = settled
        .iter()
        .filter(|f| Tier::of(f) != Tier::Refuted)
        .filter(|f| f.get(LEDGER_DUP) != Some(&Value::Bool(true)))
        .map(LedgerRow::open)
        .collect();
    let mut tombstones = chain.tombstones.clone();
    for p in &chain.priors {
        match p.fate {
            Fate::Resolved => tombstones.push(LedgerRow {
                disposition: "closed".into(),
                why: format!("resolved in round {}", chain.round),
                ..p.row.clone()
            }),
            Fate::Pending | Fate::StillOpen | Fate::Regressed | Fate::Unverified => {
                rows.push(LedgerRow {
                    disposition: "open".into(),
                    ..p.row.clone()
                });
            }
            Fate::Retired => tombstones.push(LedgerRow {
                disposition: "closed".into(),
                why: format!("dismissed in round {}", chain.round),
                ..p.row.clone()
            }),
            Fate::Carried | Fate::Deferred => rows.push(p.row.clone()),
            Fate::SetAside => {}
        }
    }
    let drop = tombstones.len().saturating_sub(TOMBSTONES_MAX);
    rows.extend(tombstones.into_iter().skip(drop));
    rows
}
