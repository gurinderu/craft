use std::collections::BTreeMap;

use super::{Apart, Round, add, add_apart};
use crate::js::parse;

fn record(text: &str) -> crate::js::Obj {
    parse(text).unwrap().as_obj().unwrap().clone()
}

#[test]
fn each_round_sums_the_rows_that_carry_its_yield_and_passes_over_the_rest() {
    let mut rounds = BTreeMap::new();
    add(
        &record(
            r#"{"lensRounds": [{"round": 1, "raw": 10, "newUnique": 4, "confirmed": 2, "confirmedMediumPlus": 1},
                                {"round": 2, "raw": 8, "newUnique": 1, "confirmed": 0, "confirmedMediumPlus": 0},
                                {"round": 3, "raw": 2, "newUnique": 1}, "not a row"]}"#,
        ),
        &mut rounds,
    );
    add(
        &record(
            r#"{"lensRounds": [{"round": 1, "raw": 6, "newUnique": 2, "confirmed": 1, "confirmedMediumPlus": 1}]}"#,
        ),
        &mut rounds,
    );
    let one = Round {
        runs: 2,
        raw: 16.0,
        new_unique: 6.0,
        confirmed: 3.0,
        confirmed_medium_plus: 2.0,
    };
    assert_eq!(rounds.get(&1), Some(&one));
    assert_eq!(rounds.get(&2).map(|r| r.runs), Some(1));
    assert_eq!(
        rounds.get(&3),
        None,
        "a run ended before verification adds nothing"
    );
}

#[test]
fn the_seeds_and_the_unattributed_sum_apart() {
    let mut apart = Apart::default();
    let r = r#"{"seedYield": {"unique": 2, "confirmed": 2, "confirmedMediumPlus": 1}, "unattributedConfirmed": 3}"#;
    add_apart(&record(r), &mut apart);
    add_apart(&record(r#"{"seedYield": {"unique": 2}}"#), &mut apart);
    let want = Apart {
        seed_runs: 1,
        seed_confirmed: 2.0,
        seed_medium_plus: 1.0,
        unattributed_runs: 1,
        unattributed_confirmed: 3.0,
    };
    assert_eq!(apart, want);
}

#[test]
fn an_old_record_without_the_yield_adds_nothing() {
    let mut rounds = BTreeMap::new();
    let mut apart = Apart::default();
    for r in [
        r#"{"lensRounds": [{"round": 1, "agents": 3, "returned": 3, "newFindings": 2}]}"#,
        r#"{"verdict": "Approve"}"#,
    ] {
        add(&record(r), &mut rounds);
        add_apart(&record(r), &mut apart);
    }
    assert!(rounds.is_empty() && apart.is_empty());
}
