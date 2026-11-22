use serde_json::{Value, json};

use super::{apart, lens_rounds};
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

/// A finding of `origin` (a lens round's when `round` is given), judged `tier` at `severity`.
fn found(origin: &str, round: Option<u32>, severity: &str, tier: &str) -> Value {
    let mut f = json!({"foundBy": origin, "foundInRound": round.unwrap_or(1), "severity": severity, "tier": tier});
    if let Some(r) = round {
        f["lensRound"] = json!(r);
    }
    f
}

/// A pool of every origin: lens rounds 1 and 3, a seed, an extra (round 1, no lens round), a
/// seam, a critic's and one that names none.
fn pool() -> Vec<Value> {
    vec![
        found("lens", Some(1), "High", "confirmed"),
        found("lens", Some(1), "Low", "confirmed"),
        found("lens", Some(1), "Medium", "suspected"),
        found("lens", Some(3), "Medium", "confirmed"),
        found("lens", Some(3), "Low", "refuted"),
        found("gate", None, "Medium", "confirmed"),
        found("extra", None, "High", "confirmed"),
        found("seam", None, "Low", "confirmed"),
        found("critic", None, "Medium", "confirmed"),
        json!({"severity": "Info", "tier": "confirmed"}),
    ]
}

#[test]
fn each_round_carries_only_its_lens_findings_split_by_severity() {
    let mut r = run(&[(1, 5), (2, 4), (3, 2)]);
    r.telemetry.deduped(&pool());
    r.telemetry.tiers(&pool());
    let rows = lens_rounds(&r);
    assert_eq!(
        rows[0],
        json!({"round": 1, "agents": 2, "returned": 2, "newFindings": 1, "raw": 5, "newUnique": 3,
               "confirmed": 2, "confirmedMediumPlus": 1,
               "confirmedBySeverity": {"Critical": 0, "High": 1, "Medium": 0, "Low": 1, "Info": 0},
               "suspected": 1, "suspectedBySeverity": {"Critical": 0, "High": 0, "Medium": 1, "Low": 0, "Info": 0}})
    );
    let pick = |row: &Value| (row["newUnique"].clone(), row["confirmed"].clone());
    let picked: Vec<_> = rows.iter().map(pick).collect();
    assert_eq!(
        picked,
        [
            (json!(3), json!(2)),
            (json!(0), json!(0)),
            (json!(2), json!(1))
        ]
    );
    assert!(
        rows.iter()
            .all(|row| row["newUnique"].as_u64() <= row["raw"].as_u64())
    );
}

#[test]
fn the_rounds_the_seeds_and_the_unattributed_add_up_to_every_confirmed_finding() {
    let mut r = run(&[(1, 5), (3, 2)]);
    r.telemetry.deduped(&pool());
    r.telemetry.tiers(&pool());
    let rows: u64 = lens_rounds(&r)
        .iter()
        .filter_map(|y| y["confirmed"].as_u64())
        .sum();
    let apart = apart(&r);
    let seeds = apart["seedYield"]["confirmed"].as_u64().unwrap();
    let unattributed = apart["unattributedConfirmed"].as_u64().unwrap();
    let all = pool().iter().filter(|f| f["tier"] == "confirmed").count() as u64;
    assert_eq!((rows, seeds, unattributed), (3, 1, 4));
    assert_eq!(rows + seeds + unattributed, all);
    let other = &apart["unattributedYield"];
    let names: Vec<&String> = other.as_object().unwrap().keys().collect();
    assert_eq!(names, ["critic", "extra", "other", "seam"]);
    assert_eq!(other["extra"]["confirmedMediumPlus"], 1);
}

#[test]
fn a_run_before_its_dedup_carries_the_rounds_alone_and_one_before_verification_no_tiers() {
    let mut r = run(&[(1, 5)]);
    r.telemetry.tiers(&pool());
    assert_eq!(
        lens_rounds(&r)[0].get("newUnique"),
        None,
        "no dedup counted"
    );
    assert!(apart(&r).is_empty());
    r.telemetry.deduped(&pool());
    let row = &lens_rounds(&r)[0];
    assert_eq!(
        (row["newUnique"].clone(), row.get("confirmed")),
        (json!(3), None)
    );
    let apart = apart(&r);
    assert_eq!(apart["seedYield"], json!({"unique": 1}));
    assert_eq!(apart.get("unattributedConfirmed"), None);
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
    assert_eq!(apart(&r)["unattributedConfirmed"], 0);
    let old: RoundYield =
        serde_json::from_value(json!({"round": 1, "agents": 1, "returned": 1, "newFindings": 0}))
            .unwrap();
    assert_eq!(old.raw, None);
    assert_eq!(serde_json::to_value(&old).unwrap().get("raw"), None);
}
