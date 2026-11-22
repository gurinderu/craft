use serde_json::{Value, json};

use super::lens_rounds;
use crate::rounds::RoundYield;
use crate::state::RunState;

fn run(yields: &[(u32, usize)]) -> RunState {
    let rows: Vec<Value> = yields
        .iter()
        .map(|(round, raw)| json!({"round": round, "agents": 2, "returned": 2, "newFindings": 1, "raw": raw}))
        .collect();
    serde_json::from_value(json!({
        "version": crate::state::STATE_VERSION,
        "context": {"repo": "/r", "base": "origin/main", "spec": "", "craftRoot": null, "craftVersion": null},
        "diff": {"base": "origin/main", "mergeBase": "m", "head": "h", "dirty": false, "files": [], "stat": "", "log": ""},
        "tracks": [], "light": false, "phase": "verify", "tasks": [],
        "rounds": {"round": 3, "pool": [], "yields": rows, "expected": [], "returned": [], "failures": {}},
        "findings": [], "settled": [], "notes": [], "notRun": []
    }))
    .unwrap()
}

fn found(round: u64, tier: &str) -> Value {
    json!({"foundInRound": round, "tier": tier})
}

#[test]
fn each_round_carries_its_raw_new_unique_and_confirmed_by_earliest_round() {
    let mut r = run(&[(1, 5), (2, 4), (3, 2)]);
    let pool = [
        found(1, ""),
        found(1, ""),
        found(3, ""),
        json!({"title": "the critic's"}),
    ];
    r.telemetry.deduped(&pool);
    r.telemetry.confirmed(&[
        found(1, "confirmed"),
        found(1, "refuted"),
        found(3, "confirmed"),
    ]);
    let rows = lens_rounds(&r);
    let pick = |row: &Value| {
        (
            row["raw"].clone(),
            row["newUnique"].clone(),
            row["confirmed"].clone(),
        )
    };
    assert_eq!(
        rows.iter().map(pick).collect::<Vec<_>>(),
        [
            (json!(5), json!(2), json!(1)),
            (json!(4), json!(0), json!(0)),
            (json!(2), json!(1), json!(1))
        ]
    );
    assert_eq!(
        rows[0],
        json!({"round": 1, "agents": 2, "returned": 2, "newFindings": 1, "raw": 5, "newUnique": 2, "confirmed": 1})
    );
}

#[test]
fn a_run_before_its_dedup_carries_the_rounds_alone_and_one_before_verification_no_confirmed() {
    let mut r = run(&[(1, 5)]);
    r.telemetry.confirmed(&[found(1, "confirmed")]);
    assert_eq!(
        lens_rounds(&r)[0].get("newUnique"),
        None,
        "no dedup counted"
    );
    r.telemetry.deduped(&[found(1, "")]);
    let row = &lens_rounds(&r)[0];
    assert_eq!(
        (row["newUnique"].clone(), row.get("confirmed")),
        (json!(1), None)
    );
}

#[test]
fn an_empty_pool_counts_zero_in_every_round_and_an_old_yield_reads_without_raw() {
    let mut r = run(&[(1, 0)]);
    r.telemetry.nothing_pooled();
    let row = &lens_rounds(&r)[0];
    assert_eq!(
        (row["newUnique"].clone(), row["confirmed"].clone()),
        (json!(0), json!(0))
    );
    let old: RoundYield =
        serde_json::from_value(json!({"round": 1, "agents": 1, "returned": 1, "newFindings": 0}))
            .unwrap();
    assert_eq!(old.raw, None);
    assert_eq!(serde_json::to_value(&old).unwrap().get("raw"), None);
}
