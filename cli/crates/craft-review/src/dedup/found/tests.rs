use serde_json::{Value, json};

use super::{GATE, LENS, stamped, with_rounds};

fn lens(round: u32) -> Value {
    stamped(json!({"foundInRound": round}), LENS, Some(round))
}

#[test]
fn a_finding_raised_in_rounds_one_and_three_is_round_ones_with_both() {
    let (a, b) = (lens(3), lens(1));
    let m = with_rounds(a.clone(), &[&a, &b]);
    assert_eq!(
        (
            m["foundInRound"].clone(),
            m["lensRound"].clone(),
            m["foundInRounds"].clone()
        ),
        (json!(1), json!(1), json!([1, 3]))
    );
    assert_eq!(m["foundBy"], "lens");
}

#[test]
fn a_seed_a_lens_round_copied_stays_a_seed_and_an_extra_lends_no_lens_round() {
    let seed = stamped(json!({"foundInRound": 0}), GATE, None);
    let m = with_rounds(seed.clone(), &[&seed, &lens(1)]);
    assert_eq!(
        (m["foundBy"].clone(), m["foundInRound"].clone()),
        (json!("gate"), json!(0))
    );
    let extra = stamped(json!({"foundInRound": 1}), "extra", None);
    let m = with_rounds(extra.clone(), &[&extra, &lens(2)]);
    assert_eq!(
        (
            m["foundBy"].clone(),
            m["foundInRound"].clone(),
            m["lensRound"].clone()
        ),
        (json!("lens"), json!(1), json!(2)),
        "the lens round is the lens member's, not the extra's round"
    );
    let m = with_rounds(extra.clone(), &[&extra]);
    assert_eq!(
        (m["foundBy"].clone(), m.get("lensRound")),
        (json!("extra"), None)
    );
}

#[test]
fn a_merge_of_merges_unions_their_rounds_and_one_without_rounds_is_left_as_is() {
    let a = with_rounds(lens(2), &[&lens(2), &lens(3)]);
    assert_eq!(
        with_rounds(json!({}), &[&a, &lens(1)])["foundInRounds"],
        json!([1, 2, 3])
    );
    assert_eq!(with_rounds(json!({"t": 1}), &[&json!({})]), json!({"t": 1}));
}
