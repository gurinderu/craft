//! The lens rounds that raised a finding: `foundInRound`, the round that first found it, and on a
//! merge of several (an exact copy, a rolled-up flood, a same-defect group) `foundInRounds`, every
//! round any member was raised in, so the record can say what each round added after the dedup.

use std::collections::BTreeSet;

use serde_json::{Value, json};

/// The rounds `f` was raised in: its `foundInRounds`, else its `foundInRound`, else none.
fn rounds_of(f: &Value) -> BTreeSet<u64> {
    match f.get("foundInRounds").and_then(Value::as_array) {
        Some(all) => all.iter().filter_map(Value::as_u64).collect(),
        None => f
            .get("foundInRound")
            .and_then(Value::as_u64)
            .into_iter()
            .collect(),
    }
}

/// `f` as the merge of `members`: first found when the earliest of them was, raised in every
/// round any of them was. Unchanged when no member names a round.
pub(crate) fn with_rounds(mut f: Value, members: &[&Value]) -> Value {
    let all: BTreeSet<u64> = members.iter().flat_map(|m| rounds_of(m)).collect();
    if let (Some(&first), Some(obj)) = (all.first(), f.as_object_mut()) {
        obj.insert("foundInRound".into(), json!(first));
        obj.insert("foundInRounds".into(), json!(all));
    }
    f
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::with_rounds;

    #[test]
    fn a_finding_raised_in_rounds_one_and_three_is_round_ones_with_both() {
        let (a, b) = (json!({"foundInRound": 3}), json!({"foundInRound": 1}));
        let m = with_rounds(a.clone(), &[&a, &b]);
        assert_eq!(
            (m["foundInRound"].clone(), m["foundInRounds"].clone()),
            (json!(1), json!([1, 3]))
        );
    }

    #[test]
    fn a_merge_of_merges_unions_their_rounds_and_one_without_rounds_is_left_as_is() {
        let (a, b) = (
            json!({"foundInRounds": [2, 3], "foundInRound": 2}),
            json!({"foundInRound": 1}),
        );
        assert_eq!(
            with_rounds(json!({}), &[&a, &b])["foundInRounds"],
            json!([1, 2, 3])
        );
        assert_eq!(with_rounds(json!({"t": 1}), &[&json!({})]), json!({"t": 1}));
    }
}
