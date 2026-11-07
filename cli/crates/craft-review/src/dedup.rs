//! The pool before verification (`lib/review-dedup.mjs`): the path floor, the mechanical roll-up of
//! low-value rule floods, then the cross-lens dedup — a model pass groups findings that word one
//! defect differently, a deterministic pass groups those at one `file:line` with near-identical
//! titles, and each connected component of both merges into one finding.

mod merge;

use serde_json::{Value, json};

use crate::harm::raise_path_floor;
use crate::profile::Profile;

pub(crate) use merge::merge;

/// At most this many findings of one roll-up rule from one lens are kept as they are, as
/// `ROLLUP_MAX`.
const ROLLUP_MAX: usize = 3;

/// A severity's rank, worst first, unknown last, as `SEV_RANK`.
pub(crate) fn sev_rank(f: &Value) -> usize {
    let sev = f.get("severity").and_then(Value::as_str).unwrap_or("");
    ["Critical", "High", "Medium", "Low", "Info"]
        .iter()
        .position(|s| *s == sev)
        .unwrap_or(9)
}

fn text<'a>(f: &'a Value, k: &str) -> &'a str {
    f.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `f` as the merge of `members`: first found when the earliest of them was.
pub(crate) fn with_earliest_round(mut f: Value, members: &[&Value]) -> Value {
    let earliest = members
        .iter()
        .filter_map(|m| m.get("foundInRound").and_then(Value::as_u64))
        .min();
    if let (Some(r), Some(obj)) = (earliest, f.as_object_mut()) {
        obj.insert("foundInRound".into(), json!(r));
    }
    f
}

/// Whether `f`'s rule is one its profile rolls up.
fn rolls_up(f: &Value, profiles: &[Profile]) -> bool {
    let rule = text(f, "ruleId");
    profiles
        .iter()
        .find(|p| p.id == text(f, "profile"))
        .is_some_and(|p| p.rollup_rule_ids.iter().any(|i| i == rule))
}

/// The pool through the path floor and the roll-up, as `rollupPool(applyPathFloor(pool))` does
/// per profile: a finding is rolled up under its own profile's rules, with its lens's findings of
/// that rule.
#[must_use]
pub fn prepare(pool: &[Value], profiles: &[Profile]) -> Vec<Value> {
    let floored: Vec<Value> = pool.iter().map(raise_path_floor).collect();
    let mut out = Vec::new();
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for f in floored {
        if !rolls_up(&f, profiles) {
            out.push(f);
            continue;
        }
        let k = format!(
            "{}::{}::{}",
            text(&f, "profile"),
            text(&f, "source"),
            text(&f, "ruleId")
        );
        match groups.iter_mut().find(|(g, _)| *g == k) {
            Some((_, g)) => g.push(f),
            None => groups.push((k, vec![f])),
        }
    }
    for (_, g) in groups {
        out.extend(rolled_up(g));
    }
    out
}

/// One roll-up group: as is up to [`ROLLUP_MAX`], else the worst [`ROLLUP_MAX`] and one finding
/// folding the rest.
fn rolled_up(mut g: Vec<Value>) -> Vec<Value> {
    g.sort_by_key(sev_rank);
    if g.len() <= ROLLUP_MAX {
        return g;
    }
    let folded = g.split_off(ROLLUP_MAX);
    let Some(rep) = folded.first() else {
        return g;
    };
    let where_ = folded
        .iter()
        .take(6)
        .map(|f| {
            let file = text(f, "file");
            let line = f.get("line").and_then(Value::as_i64).unwrap_or(0);
            format!("{}:{line}", if file.is_empty() { "?" } else { file })
        })
        .collect::<Vec<_>>()
        .join(", ");
    let rule = text(rep, "ruleId");
    let mut one = rep.as_object().cloned().unwrap_or_default();
    one.insert(
        "title".into(),
        json!(format!(
            "{} — and {} more of the same ({rule})",
            text(rep, "title"),
            folded.len() - 1
        )),
    );
    one.insert("why".into(), json!(format!(
        "{} Repeated {} more times across the diff ({where_}{}); rolled into one finding because per-occurrence reporting of this rule buries the rest of the review. Fix the pattern, not the instance.",
        text(rep, "why"),
        folded.len(),
        if folded.len() > 6 { ", …" } else { "" }
    )));
    let members: Vec<&Value> = folded.iter().collect();
    g.push(with_earliest_round(Value::Object(one), &members));
    g
}

#[cfg(test)]
mod tests;
