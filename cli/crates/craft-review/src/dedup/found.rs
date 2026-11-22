//! Where a finding came from (realm @nick/craft, node #248): `foundBy`, its origin — a lens round
//! (`lens`, with `lensRound`), the gate's seeds (`gate`), an extra lens (`extra`), a unit-mode seam
//! pass (`seam`), the completeness critic (`critic`) —, and `foundInRound`, the round it first
//! entered the pool. A merge of several (an exact copy, a rolled-up flood, a same-defect group)
//! keeps the earliest `foundInRound`, the strongest origin (a seed over a lens round over the
//! rest), the earliest `lensRound` and `foundInRounds`, every lens round that raised a member.

use std::collections::BTreeSet;

use serde_json::{Value, json};

/// The origin of a lens round's finding.
pub(crate) const LENS: &str = "lens";
/// The origin of a gate seed.
pub(crate) const GATE: &str = "gate";

/// `f` stamped with its `origin`, and `round` as its lens round when a lens round raised it.
pub(crate) fn stamped(mut f: Value, origin: &str, round: Option<u32>) -> Value {
    if let Some(obj) = f.as_object_mut() {
        obj.insert("foundBy".into(), json!(origin));
        if let Some(r) = round {
            obj.insert("lensRound".into(), json!(r));
        }
    }
    f
}

/// The lens rounds that raised `f`: its `foundInRounds`, else its `lensRound`, else none.
fn lens_rounds_of(f: &Value) -> BTreeSet<u64> {
    match f.get("foundInRounds").and_then(Value::as_array) {
        Some(all) => all.iter().filter_map(Value::as_u64).collect(),
        None => f
            .get("lensRound")
            .and_then(Value::as_u64)
            .into_iter()
            .collect(),
    }
}

/// The strongest origin among `members`: a seed, then a lens round, then the first named.
fn origin_of(members: &[&Value]) -> Option<String> {
    let named: Vec<&str> = members
        .iter()
        .filter_map(|m| m.get("foundBy").and_then(Value::as_str))
        .collect();
    [GATE, LENS]
        .into_iter()
        .find(|o| named.contains(o))
        .or_else(|| named.first().copied())
        .map(str::to_owned)
}

/// `f` as the merge of `members`, its rounds and origin theirs as the module says. Unchanged
/// where no member names them.
pub(crate) fn with_rounds(mut f: Value, members: &[&Value]) -> Value {
    let first = members
        .iter()
        .filter_map(|m| m.get("foundInRound").and_then(Value::as_u64))
        .min();
    let lens: BTreeSet<u64> = members.iter().flat_map(|m| lens_rounds_of(m)).collect();
    let origin = origin_of(members);
    let Some(obj) = f.as_object_mut() else {
        return f;
    };
    if let Some(r) = first {
        obj.insert("foundInRound".into(), json!(r));
    }
    if let Some(o) = origin {
        obj.insert("foundBy".into(), json!(o));
    }
    if let Some(&r) = lens.first() {
        obj.insert("lensRound".into(), json!(r));
        obj.insert("foundInRounds".into(), json!(lens));
    }
    f
}

#[cfg(test)]
mod tests;
