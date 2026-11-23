//! The ledger the triage returns and tallies: the plan agent's, with every row this side settled
//! itself restored.
//!
//! The restored rows are an unjudged one and a sifted one, whatever the agent paraphrased or
//! dropped; the rows a class-1 verdict carries get the issue action (realm @nick/craft, node #303).
//! A row is the agent's object as it came, extended in place as the engine extends it, and a
//! row that is no object passes through untouched.

use std::collections::HashSet;

use crate::issue::with_issue_actions;
use crate::js;
use crate::json::{Json, Obj};
use crate::ledger::{Row, UNJUDGED_MARKER};
use crate::sift::SIFT_MARK;

/// The rows this side settled, by id in first-insertion order, a later row under one id
/// replacing an earlier one: the sifted rows, then every verdict marked unjudged.
fn pinned_rows<'a>(sifted: &'a [Row], validations: &'a [Row]) -> Vec<(&'a str, &'a Row)> {
    let unjudged = validations
        .iter()
        .filter(|v| js_reason(v).contains(UNJUDGED_MARKER));
    let mut pinned: Vec<(&str, &Row)> = Vec::new();
    for row in sifted.iter().chain(unjudged) {
        match pinned.iter_mut().find(|(id, _)| *id == row.id()) {
            Some(p) => p.1 = row,
            None => pinned.push((row.id(), row)),
        }
    }
    pinned
}

/// `String(e.reason || '')`.
fn js_reason(r: &Row) -> String {
    let reason = r.0.get("reason");
    if js::truthy(reason) {
        js::string(reason)
    } else {
        String::new()
    }
}

/// The plan's row `e` against the pinned row `v`: kept when it already says what `v` does, its
/// mark included, else `v`'s verdict, reason, `sifted` and a repeat's `repeat_of` (realm
/// @nick/craft, node #312) spread over it.
fn pin(e: &Obj, v: &Row) -> Obj {
    let mark = if v.text("reason").contains(UNJUDGED_MARKER) {
        UNJUDGED_MARKER
    } else {
        SIFT_MARK
    };
    let same = |k: &str| e.get(k) == v.0.get(k);
    if js_reason(&Row(e.clone())).contains(mark)
        && same("verdict")
        && same("sifted")
        && same("repeat_of")
    {
        return e.clone();
    }
    restored(e.clone(), v)
}

fn restored(mut e: Obj, v: &Row) -> Obj {
    for k in ["verdict", "reason"] {
        if let Some(x) = v.0.get(k) {
            e.set(k, x.clone());
        }
    }
    if js::truthy(v.0.get("sifted")) {
        e.set("sifted", true);
    }
    if let Some(of) = v.0.get("repeat_of").filter(|of| js::truthy(Some(of))) {
        e.set("repeat_of", of.clone());
    }
    e
}

/// `planned` with each pinned row restored and a pinned row the agent dropped appended.
#[must_use]
pub fn pinned_ledger(planned: &[Json], sifted: &[Row], validations: &[Row]) -> Vec<Json> {
    let pinned = pinned_rows(sifted, validations);
    if pinned.is_empty() {
        return planned.to_vec();
    }
    let mut seen = HashSet::new();
    let find = |e: &Obj| {
        e.get("stable_id")
            .and_then(Json::as_str)
            .and_then(|id| pinned.iter().find(|(p, _)| *p == id))
    };
    let mut rows: Vec<Json> = planned
        .iter()
        .map(
            |e| match e.as_object().and_then(|o| find(o).map(|p| (o, p))) {
                Some((o, (id, v))) => {
                    seen.insert(*id);
                    Json::Object(pin(o, v))
                }
                None => e.clone(),
            },
        )
        .collect();
    let dropped = pinned.iter().filter(|(id, _)| !seen.contains(id));
    rows.extend(
        dropped.map(|(id, v)| Json::Object(restored(Obj::new().with("stable_id", *id), v))),
    );
    rows
}

/// The ledger the record tallies: the plan's list pinned, or with no list the sifted rows and the
/// verdicts; the issue actions on both.
#[must_use]
pub fn final_ledger(planned: Option<&[Json]>, sifted: &[Row], validations: &[Row]) -> Vec<Json> {
    let rows = match planned {
        Some(p) => pinned_ledger(p, sifted, validations),
        None => sifted
            .iter()
            .chain(validations)
            .cloned()
            .map(Json::from)
            .collect(),
    };
    with_issue_actions(rows, validations)
}

#[cfg(test)]
mod tests;
