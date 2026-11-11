//! The memory applied to a run's findings and to the prior round's (`setAsidePhase` in
//! `lib/review-set-aside.mjs`; realm @nick/craft, nodes #204, #218, #273): the verified findings and
//! the priors still open are split by the records in hand — the decisions first, the match judge
//! asked about their near misses, then the project rules, the rule judge asked about the findings
//! in their scope — and a deferred prior is held while its question is (`deferralHeld`,
//! `deferralReleased` in `lib/prior-decision-apply.mjs`). Each judge is a task of its own step: the
//! pairs it is asked about, and the scopes git observed for them, are kept in the run's state when
//! its task is handed out ([`super::Asked`]) and read back with its answer, so git is asked once.

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;

use super::{Memory, PriorDecision, RecordKind, apply, matching, rules};
use crate::content::ContentError;
use crate::git;
use crate::ledger::{Deferral, LedgerRow};
use crate::report::Tier;
use crate::rereview::{Chain, Fate};
use crate::state::Task;

/// The field a prior carries through the split, naming its place in the chain.
const PRIOR_AT: &str = "priorIndex";
/// The mark of a finding going against a record (`memoryContradicts`).
const CONTRADICTS: &str = "memoryContradicts";

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

    /// The match judge's task over the findings of `settled` and the priors still open or carried
    /// unverified in `chain` (the engine's `stillOpen`, `regressed` and `unverified` tiers), `None`
    /// when no pair needs it. What it is asked, the scopes git observed for it included, is kept
    /// for [`Memory::apply`].
    ///
    /// # Errors
    /// When its template or schema is missing.
    pub(crate) fn match_task(
        &mut self,
        repo: &Path,
        settled: &[Value],
        chain: &Chain,
    ) -> Result<Option<Task>, ContentError> {
        self.asked.matched = None;
        let judged = pool(settled, chain);
        if self.decisions.is_empty() || judged.is_empty() {
            return Ok(None);
        }
        let check = |ds: &[&PriorDecision]| scope_check(repo, ds);
        let prepared = apply::prepare(&judged, &self.decisions, &check);
        self.asked.matched = Some(prepared.to_keep());
        prepared.task(&judged)
    }

    /// Sets aside what a record answers among the same findings and priors as
    /// [`Memory::match_task`], `answer` the match judge's when it was asked, read against the pairs
    /// and scopes that task kept — its scope checked by git in `repo` only when none was kept; what
    /// it did goes to `notes`. A prior set aside leaves the chain's ledger for the memory's; one
    /// raised again keeps the note why.
    pub(crate) fn apply(
        &mut self,
        repo: &Path,
        settled: &mut Vec<Value>,
        chain: &mut Chain,
        notes: &mut Vec<String>,
        answer: Option<&Value>,
    ) {
        let kept = self.asked.matched.take();
        let judged = pool(settled, chain);
        if self.decisions.is_empty() || judged.is_empty() {
            return;
        }
        let prepared = if let Some(asked) = &kept {
            apply::prepare_asked(&judged, &self.decisions, asked)
        } else {
            let check = |ds: &[&PriorDecision]| scope_check(repo, ds);
            apply::prepare(&judged, &self.decisions, &check)
        };
        let out = apply::apply(judged, &prepared, answer);
        self.set_aside = commit(settled, chain, out.kept, out.set_aside);
        notes.extend(out.notes.iter().map(|n| format!("prior decisions: {n}")));
        self.refused.extend(out.refused);
    }

    /// The rule judge's task over what the decisions left, `None` when no finding sits in a rule's
    /// scope. The pairs it is asked about are kept for [`Memory::cover`].
    ///
    /// # Errors
    /// When its template or schema is missing.
    pub(crate) fn rule_task(
        &mut self,
        settled: &[Value],
        chain: &Chain,
    ) -> Result<Option<Task>, ContentError> {
        let judged = pool(settled, chain);
        let pairs = rules::Pairs::new(&judged, &self.decisions);
        self.asked.ruled = Some(pairs.pairs().to_vec());
        pairs.task(&judged)
    }

    /// Covers by the project rules what the decisions left, `answer` the rule judge's when it was
    /// asked, read against the pairs [`Memory::rule_task`] kept; a covered prior leaves the chain's
    /// ledger for the memory's, as `covered`.
    pub(crate) fn cover(
        &mut self,
        settled: &mut Vec<Value>,
        chain: &mut Chain,
        notes: &mut Vec<String>,
        answer: Option<&Value>,
    ) {
        let kept = self.asked.ruled.take();
        let judged = pool(settled, chain);
        if !self.decisions.iter().any(|d| d.kind == RecordKind::Rule) || judged.is_empty() {
            return;
        }
        let mut pairs = rules::Pairs::new(&judged, &self.decisions);
        if let Some(asked) = kept {
            pairs.asked(asked);
        }
        // As the engine does: with no rule in force the rules say nothing, superseded ones included.
        if !pairs.any() {
            return;
        }
        let out = rules::apply(judged, &pairs, answer);
        let covered = commit(settled, chain, out.kept, out.covered);
        self.set_aside.extend(covered);
        self.rule_notices = out.notices;
        notes.extend(out.notes.iter().map(|n| format!("project rules: {n}")));
    }
}

/// What the records are applied to: the findings of `settled` not refuted, then the priors still
/// open or carried unverified in `chain`, each carrying its place in the chain and its mark.
fn pool(settled: &[Value], chain: &Chain) -> Vec<Value> {
    let mut out: Vec<Value> = settled
        .iter()
        .filter(|f| Tier::of(f) != Tier::Refuted)
        .cloned()
        .collect();
    for (i, p) in chain.priors.iter().enumerate() {
        if !(p.gates() || p.fate == Fate::Unverified) {
            continue;
        }
        if let Value::Object(mut f) = p.row.finding() {
            f.insert(PRIOR_AT.into(), Value::from(i));
            if let Some(m) = &p.contradicts {
                f.insert(CONTRADICTS.into(), m.clone());
            }
            out.push(Value::Object(f));
        }
    }
    out
}

/// Puts what a split `kept` back: a finding of this round into `settled` beside the refuted ones,
/// a prior's note and mark onto its row. The findings `aside` are returned without their place,
/// a prior among them set aside in `chain`.
fn commit(
    settled: &mut Vec<Value>,
    chain: &mut Chain,
    kept: Vec<Value>,
    aside: Vec<Value>,
) -> Vec<Value> {
    let refuted: Vec<Value> = settled
        .drain(..)
        .filter(|f| Tier::of(f) == Tier::Refuted)
        .collect();
    for f in kept {
        match take_prior(&f) {
            Some((i, f)) => {
                if let Some(p) = chain.priors.get_mut(i) {
                    f.get("why")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .clone_into(&mut p.row.why);
                    p.contradicts = f.get(CONTRADICTS).cloned();
                }
            }
            None => settled.push(f),
        }
    }
    settled.extend(refuted);
    aside
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
        .collect()
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
