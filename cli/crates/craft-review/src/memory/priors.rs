//! The memory applied to a run's findings and to the prior round's (`setAsidePhase` in
//! `lib/review-set-aside.mjs`; realm @nick/craft, nodes #204, #218): the verified findings and the
//! priors still open are split by the records in hand, and a deferred prior is held while its
//! question is (`deferralHeld`, `deferralReleased` in `lib/prior-decision-apply.mjs`).

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;

use super::{Memory, PriorDecision, apply, matching};
use crate::git;
use crate::ledger::{Deferral, LedgerRow};
use crate::report::Tier;
use crate::rereview::{Chain, Fate};

/// The field a prior carries through the split, naming its place in the chain.
const PRIOR_AT: &str = "priorIndex";

/// Every id a record is known by: its own and the store's.
fn aliases(d: &PriorDecision) -> impl Iterator<Item = &String> {
    std::iter::once(&d.id).chain(&d.stores)
}

/// Whether a record in hand releases `deferral`: one names its question, by any id it is known
/// by, in a `supersedes:` or `answers:` link. The question's absence never releases it.
fn released(deferral: &Deferral, records: &[PriorDecision]) -> bool {
    let mut ids: BTreeSet<&String> = BTreeSet::from([&deferral.id]);
    for d in records
        .iter()
        .filter(|d| aliases(d).any(|a| *a == deferral.id))
    {
        ids.extend(aliases(d));
    }
    records
        .iter()
        .any(|d| d.supersedes.iter().any(|s| ids.contains(s)))
}

impl Memory {
    /// Whether a `deferred` prior's question still holds it: it carries a deferral, it is not
    /// Critical or High, and no record in hand releases it.
    #[must_use]
    pub fn holds(&self, row: &LedgerRow) -> bool {
        let Some(deferral) = &row.deferral else {
            return false;
        };
        !matching::reraised_by_severity(&row.finding()) && !released(deferral, &self.decisions)
    }

    /// Sets aside the findings of `settled` and the priors still open or carried unverified in
    /// `chain` (the engine's `stillOpen`, `regressed` and `unverified` tiers) a record answers,
    /// its scope checked by git in `repo`; what it did goes to `notes`. A prior set aside leaves
    /// the chain's ledger for the memory's; one raised again keeps the note why.
    pub(crate) fn apply(
        &mut self,
        repo: &Path,
        settled: &mut Vec<Value>,
        chain: &mut Chain,
        notes: &mut Vec<String>,
    ) {
        let live: Vec<usize> = (0..chain.priors.len())
            .filter(|&i| {
                chain
                    .priors
                    .get(i)
                    .is_some_and(|p| p.gates() || p.fate == Fate::Unverified)
            })
            .collect();
        if self.decisions.is_empty() || (settled.is_empty() && live.is_empty()) {
            return;
        }
        let (refuted, mut judged): (Vec<Value>, Vec<Value>) = settled
            .drain(..)
            .partition(|f| Tier::of(f) == Tier::Refuted);
        for &i in &live {
            if let Some(Value::Object(mut f)) = chain.priors.get(i).map(|p| p.row.finding()) {
                f.insert(PRIOR_AT.into(), Value::from(i));
                judged.push(Value::Object(f));
            }
        }
        let check = |ds: &[&PriorDecision]| scope_check(repo, ds);
        let out = apply::apply(judged, &self.decisions, &check);
        for f in out.kept {
            match take_prior(&f) {
                Some((i, f)) => {
                    if let Some(p) = chain.priors.get_mut(i) {
                        p.row.why = f
                            .get("why")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                    }
                }
                None => settled.push(f),
            }
        }
        settled.extend(refuted);
        self.set_aside = out
            .set_aside
            .into_iter()
            .map(|f| match take_prior(&f) {
                Some((i, f)) => {
                    if let Some(p) = chain.priors.get_mut(i) {
                        p.fate = Fate::SetAside;
                    }
                    f
                }
                None => f,
            })
            .collect();
        notes.extend(out.notes.iter().map(|n| format!("prior decisions: {n}")));
        self.refused.extend(out.refused);
    }
}

/// A prior's place in the chain and the finding without it; `None` for a finding of this round.
fn take_prior(f: &Value) -> Option<(usize, Value)> {
    let i = usize::try_from(f.get(PRIOR_AT)?.as_u64()?).ok()?;
    let mut f = f.clone();
    if let Some(o) = f.as_object_mut() {
        o.remove(PRIOR_AT);
    }
    Some((i, f))
}

/// The scope check of `ds`, by git in `repo` (`scopeCheckScript`, run here rather than by an
/// agent): a record whose commit the repository lacks is missing; one whose scope `git diff
/// --quiet` shows untouched since its commit, the working tree included, is unchanged.
fn scope_check(repo: &Path, ds: &[&PriorDecision]) -> apply::Scope {
    let mut out = apply::Scope::default();
    for d in ds {
        if !git::has_commit(repo, &d.commit) {
            out.missing.insert(d.id.clone());
        } else if git::unchanged_since(repo, &d.commit, &d.scope) {
            out.unchanged.insert(d.id.clone());
        }
    }
    out
}
