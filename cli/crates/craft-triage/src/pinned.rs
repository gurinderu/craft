//! The ledger the triage returns and tallies: the plan agent's, with every row this side settled
//! itself restored — an unjudged one and a sifted one — whatever the agent paraphrased or dropped,
//! and the issue action on the rows a class-1 verdict carries (realm @nick/craft, node #303).

use std::collections::HashSet;

use crate::ledger::{LedgerEntry, UNJUDGED_MARKER, Validation};
use crate::sift::SIFT_MARK;

/// `planned` with each pinned row restored: its own verdict and reason, its `sifted` field and a
/// repeat's `repeat_of` (realm @nick/craft, node #312); a pinned row the agent dropped appended.
/// The pinned rows are the sifted ones and every validation marked unjudged.
#[must_use]
pub fn pinned_ledger(
    planned: &[LedgerEntry],
    sifted: &[LedgerEntry],
    validations: &[Validation],
) -> Vec<LedgerEntry> {
    let unjudged = validations
        .iter()
        .filter(|v| v.reason.contains(UNJUDGED_MARKER))
        .map(Validation::row);
    // A map in first-insertion order whose later rows under one id replace earlier ones.
    let mut pinned: Vec<LedgerEntry> = Vec::new();
    for row in sifted.iter().cloned().chain(unjudged) {
        match pinned.iter_mut().find(|p| p.stable_id == row.stable_id) {
            Some(p) => *p = row,
            None => pinned.push(row),
        }
    }
    if pinned.is_empty() {
        return planned.to_vec();
    }
    let mut seen = HashSet::new();
    let mut rows: Vec<LedgerEntry> = planned
        .iter()
        .map(
            |e| match pinned.iter().find(|v| v.stable_id == e.stable_id) {
                None => e.clone(),
                Some(v) => {
                    seen.insert(e.stable_id.clone());
                    if kept(e, v) {
                        e.clone()
                    } else {
                        restored(e, v)
                    }
                }
            },
        )
        .collect();
    for v in &pinned {
        if !seen.contains(&v.stable_id) {
            let bare = LedgerEntry {
                stable_id: v.stable_id.clone(),
                ..LedgerEntry::default()
            };
            rows.push(restored(&bare, v));
        }
    }
    rows
}

/// Whether the agent's row `e` already says what the pinned row `v` does, its mark included.
fn kept(e: &LedgerEntry, v: &LedgerEntry) -> bool {
    let mark = if v.reason.contains(UNJUDGED_MARKER) {
        UNJUDGED_MARKER
    } else {
        SIFT_MARK
    };
    e.reason.contains(mark)
        && e.verdict == v.verdict
        && e.sifted == v.sifted
        && e.repeat_of == v.repeat_of
}

/// `e` with the pinned row's verdict, reason, `sifted` and `repeat_of` over it.
fn restored(e: &LedgerEntry, v: &LedgerEntry) -> LedgerEntry {
    LedgerEntry {
        verdict: v.verdict.clone(),
        reason: v.reason.clone(),
        sifted: if v.sifted == Some(true) {
            Some(true)
        } else {
            e.sifted
        },
        repeat_of: v
            .repeat_of
            .clone()
            .filter(|r| !r.is_empty())
            .or_else(|| e.repeat_of.clone()),
        ..e.clone()
    }
}

/// `rows` with the issue action on each row a class-1 validation carries.
#[must_use]
pub fn with_issue_actions(rows: Vec<LedgerEntry>, validations: &[Validation]) -> Vec<LedgerEntry> {
    let to_issue: HashSet<&str> = validations
        .iter()
        .filter(|v| v.action.as_deref() == Some("issue"))
        .map(|v| v.stable_id.as_str())
        .collect();
    rows.into_iter()
        .map(|e| {
            if to_issue.contains(e.stable_id.as_str()) {
                LedgerEntry {
                    action: Some("issue".into()),
                    ..e
                }
            } else {
                e
            }
        })
        .collect()
}

/// The ledger the record tallies: the plan's pinned, or with no plan ledger the sifted rows and
/// the validations; the issue actions on both.
#[must_use]
pub fn final_ledger(
    planned: Option<&[LedgerEntry]>,
    sifted: &[LedgerEntry],
    validations: &[Validation],
) -> Vec<LedgerEntry> {
    let rows = match planned {
        Some(p) => pinned_ledger(p, sifted, validations),
        None => sifted
            .iter()
            .cloned()
            .chain(validations.iter().map(Validation::row))
            .collect(),
    };
    with_issue_actions(rows, validations)
}

#[cfg(test)]
mod tests;
