//! This round's verified findings reconciled with the prior round, as `reconcilePhase` in
//! `lib/review-reconcile-priors.mjs` does: one repeating a still-live prior is absorbed into it —
//! written onto its rationale, which the ledger carries and its next adjudicator is handed — and
//! one matching a tombstone is marked as a defect that came back. Only a judged finding (confirmed
//! or suspected) is absorbed: an unverified one may not hold a prior open. The CLI also keeps a
//! finding more severe than the prior it repeats as a finding of its own, so absorption never
//! lowers what the verdict counts.

use serde_json::Value;

use super::judge::field;
use super::{Chain, Fate};
use crate::absorbed;
use crate::dedup::sev_rank;
use crate::ledger;
use crate::report::Tier;

/// The order a finding's host is looked for in, as the engine's live priors are ordered.
fn host_rank(f: Fate) -> Option<u8> {
    match f {
        Fate::StillOpen | Fate::Pending => Some(0),
        Fate::Regressed => Some(1),
        Fate::Carried => Some(2),
        Fate::Resolved | Fate::Unverified => None,
    }
}

/// Where a settled finding goes: absorbed into the prior at `index`, kept as more severe than it,
/// or kept with no prior to repeat.
enum Landing {
    Into(usize),
    Severer,
    Own,
}

fn landing(chain: &Chain, hosts: &[usize], f: &Value) -> Landing {
    if !matches!(Tier::of(f), Tier::Confirmed | Tier::Suspected) {
        return Landing::Own;
    }
    let host = hosts.iter().copied().find(|i| {
        chain
            .priors
            .get(*i)
            .is_some_and(|p| ledger::repeats(f, &p.row.finding()))
    });
    match host.and_then(|i| Some((i, chain.priors.get(i)?.row.finding()))) {
        Some((_, h)) if sev_rank(f) < sev_rank(&h) => Landing::Severer,
        Some((i, _)) => Landing::Into(i),
        None => Landing::Own,
    }
}

/// The settled findings reconciled with the prior round: a judged one repeating a still-live prior
/// leaves them and is recorded on the prior's rationale; a refuted one is left alone; one matching a
/// tombstone is marked REGRESSION. Returns the notes of what it did.
pub fn absorb(chain: &mut Chain, settled: &mut Vec<Value>) -> Vec<String> {
    if chain.prior.is_none() {
        return Vec::new();
    }
    let mut hosts: Vec<usize> = (0..chain.priors.len())
        .filter(|i| {
            chain
                .priors
                .get(*i)
                .and_then(|p| host_rank(p.fate))
                .is_some()
        })
        .collect();
    hosts.sort_by_key(|i| chain.priors.get(*i).and_then(|p| host_rank(p.fate)));
    let mut severer = 0;
    let mut kept = Vec::with_capacity(settled.len());
    for f in settled.drain(..) {
        match landing(chain, &hosts, &f) {
            Landing::Into(i) => {
                if let Some(p) = chain.priors.get_mut(i) {
                    p.row.why = absorbed::absorb_into(&p.row.why, &f);
                    chain.absorbed += 1;
                }
            }
            Landing::Severer => {
                severer += 1;
                kept.push(f);
            }
            Landing::Own => kept.push(f),
        }
    }
    *settled = kept;
    mark_regressions(chain, settled);
    notes(chain, severer)
}

/// Marks each reported finding that matches a tombstone as a regression.
fn mark_regressions(chain: &mut Chain, settled: &mut [Value]) {
    for f in settled.iter_mut().filter(|f| Tier::of(f) != Tier::Refuted) {
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
}

fn notes(chain: &Chain, severer: usize) -> Vec<String> {
    let mut notes = Vec::new();
    if chain.absorbed > 0 {
        notes.push(format!("re-review: {} verified finding(s) repeated a prior finding still tracked at the same site, and were absorbed into it (recorded on its rationale, which the next round's adjudicator is handed) rather than reported twice", chain.absorbed));
    }
    if severer > 0 {
        notes.push(format!("re-review: {severer} finding(s) repeated a prior finding at its site but are more severe than it, so they are reported as findings of their own rather than absorbed"));
    }
    if chain.regressions > 0 {
        notes.push(format!("re-review: {} finding(s) match a defect an earlier round resolved, marked REGRESSION; each still counts by its severity", chain.regressions));
    }
    notes
}
