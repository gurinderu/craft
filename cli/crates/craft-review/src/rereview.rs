//! A re-review — one of the parts of the engine's review the CLI carries before the engine goes
//! (realm @nick/craft, node #445) — as the review engine's Scout, Adjudicate and
//! Synthesize phases run one (`lib/review-prior-round.mjs`, `lib/review-prior-basis.mjs`,
//! `lib/review-adjudicate-priors.mjs`, `lib/review-reconcile-priors.mjs`, `lib/review-ledger.mjs`):
//! a run of a branch builds on its newest earlier round ([`crate::chain`]); its lenses review the
//! fix commits since that round's head, or the whole diff again every `fullEvery`-th round; each
//! finding that round left open is adjudicated again; a lens finding repeating a still-live prior
//! is absorbed into it rather than reported twice; a Critical or High prior adjudicated resolved
//! is attacked by a red team before the lenses run; and its ledger carries every live finding, the
//! author's settled ones and the tombstones of resolved ones to the next round.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ledger::LedgerRow;

mod absorb;
mod carry;
mod carry_check;
mod judge;
mod red_team;
mod start;

pub use absorb::absorb;
pub use carry::ledger;
pub use judge::{hold_deferrals, judge, tasks};
pub use red_team::{take as take_attacks, tasks as attack_tasks};
pub use start::{begin, scope};
#[cfg(test)]
use {carry::TOMBSTONES_MAX, start::take_ledger};

/// What became of a prior round's finding in this one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Fate {
    /// Open, its adjudicator not yet answered.
    Pending,
    Resolved,
    StillOpen,
    /// The site changed and now holds a different defect of the same kind.
    Regressed,
    /// Set aside by its author (`rejected`, `justified`): carried until its carry-check answers.
    Carried,
    /// Never checked against the code: carried unverified, nothing to adjudicate.
    Unverified,
    /// Set aside by its author, and the code around it unchanged since: it leaves the ledger as a
    /// `dismissed` tombstone.
    Retired,
    /// Known and deferred: its question still holds (`deferralHeld`) and the code of its file is
    /// unchanged since the question's commit, so it is carried, deferred, out of the verdict.
    Deferred,
    /// Still open, but a remembered record sets it aside this round: it leaves the ledger as the
    /// author's word the memory writes (`Memory::ledger_rows`).
    SetAside,
}

/// One finding of the prior round and its fate here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PriorFinding {
    pub row: LedgerRow,
    pub fate: Fate,
    /// Its adjudicator answered this round, so its line is where the defect sits now.
    #[serde(default)]
    pub located: bool,
    /// The record a memory judge says its code goes against (`memoryContradicts`), when one does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contradicts: Option<Value>,
}

impl PriorFinding {
    /// Whether it still holds this run's verdict: open or regressed, and checked against the code.
    #[must_use]
    pub fn gates(&self) -> bool {
        matches!(self.fate, Fate::StillOpen | Fate::Regressed) && self.row.tier != "unverified"
    }
}

/// The prior run a re-review builds on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriorRun {
    pub dir: String,
    pub round: u32,
    pub head: String,
}

/// Where a run stands in its branch's chain of rounds, and what it made of the prior round.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Chain {
    /// The repository's shared git directory and the branch: the chain's key.
    pub repo: String,
    pub branch: Option<String>,
    /// The directory of the change the run reviews (`path`), the chain's key beside them; empty,
    /// the whole change.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub scope: String,
    /// This run's round, 1 on a first review.
    pub round: u32,
    /// The branch's own base, which the record names; the run's diff is what its lenses reviewed.
    pub base: String,
    pub prior: Option<PriorRun>,
    /// Why the run builds on no prior round.
    pub unchained: Option<String>,
    /// Why a re-review's lenses review the whole diff again rather than the fix commits.
    pub rescan: Option<String>,
    pub priors: Vec<PriorFinding>,
    /// The prior round's tombstones, carried.
    pub tombstones: Vec<LedgerRow>,
    /// Lens findings absorbed into a still-live prior, and fresh ones that match a tombstone.
    pub absorbed: usize,
    pub regressions: usize,
    /// The ledger the run left for its next round, once it is done.
    pub ledger: Vec<LedgerRow>,
}

impl Chain {
    /// The priors still holding the verdict, as findings.
    #[must_use]
    pub fn gating(&self) -> Vec<Value> {
        self.priors
            .iter()
            .filter(|p| p.gates())
            .map(|p| p.row.finding())
            .collect()
    }

    /// The priors still open, regressed or carried unverified that a memory judge marked as going
    /// against a record, as findings carrying the mark.
    #[must_use]
    pub fn contradicting(&self) -> Vec<Value> {
        self.priors
            .iter()
            .filter(|p| matches!(p.fate, Fate::StillOpen | Fate::Regressed | Fate::Unverified))
            .filter_map(|p| {
                let mut f = p.row.finding();
                f.as_object_mut()?
                    .insert("memoryContradicts".into(), p.contradicts.clone()?);
                Some(f)
            })
            .collect()
    }

    /// The priors carried as Known and deferred, as findings their report section lists.
    #[must_use]
    pub fn deferred(&self) -> Vec<Value> {
        self.priors
            .iter()
            .filter(|p| p.fate == Fate::Deferred)
            .map(|p| {
                let mut f = p.row.finding();
                if let Some(o) = f.as_object_mut() {
                    o.insert("priorKind".into(), Value::from("question"));
                }
                f
            })
            .collect()
    }

    /// How many priors met each fate: resolved, still open, regressed, carried, unverified, retired.
    #[must_use]
    pub fn tally(&self) -> [usize; 6] {
        let n = |f: Fate| self.priors.iter().filter(|p| p.fate == f).count();
        [
            n(Fate::Resolved),
            n(Fate::StillOpen) + n(Fate::Pending),
            n(Fate::Regressed),
            n(Fate::Carried) + n(Fate::Deferred) + n(Fate::SetAside),
            n(Fate::Unverified),
            n(Fate::Retired),
        ]
    }
}

#[cfg(test)]
mod tests;
