use std::collections::HashMap;
use std::path::Path;

use super::*;

const V: &str = "0.9.0";
const KEY: &str = "/w/app";

fn row(ts: &str, verdict: &str) -> Row {
    Row {
        ts: ts.to_owned(),
        verdict: verdict.to_owned(),
        branch: "feat/x".to_owned(),
    }
}

fn day(date: &str) -> i64 {
    day_of(date).unwrap()
}

fn runs(n: usize, verdict: &str) -> Vec<Row> {
    (0..n)
        .map(|i| row(&format!("2026-11-01T10-{i:02}-00Z"), verdict))
        .collect()
}

#[test]
fn twenty_runs_three_unclean_in_a_row_or_a_release_review_call_for_a_retro() {
    let today = day("2026-11-02");
    let since = |runs| Since {
        runs,
        last_retro: None,
    };
    assert_eq!(decide(&since(Vec::new()), today), None);
    assert_eq!(decide(&since(runs(19, "Warning")), today), None);
    assert_eq!(decide(&since(runs(20, "Warning")), today), Some(Why::Runs));
    let mut three = runs(3, "Block");
    three[1].verdict = "INCOMPLETE".into();
    three[2].verdict = "Approve (PARTIAL COVERAGE)".into();
    assert_eq!(decide(&since(three.clone()), today), Some(Why::Unclean));
    three[0].verdict = "Warning".into();
    assert_eq!(
        decide(&since(three.clone()), today),
        None,
        "one of the last three is clean"
    );
    three.push(row("2026-11-01T11-00-00Z", ""));
    assert_eq!(
        decide(&since(three), today),
        Some(Why::Unclean),
        "no verdict is none clean"
    );
    let mut release = runs(1, "Warning");
    release[0].branch = "release-please--branches--main".into();
    assert_eq!(decide(&since(release), today), Some(Why::Release));
}

#[test]
fn fourteen_days_call_for_one_only_over_five_runs_counted_from_the_last_retro() {
    let since = |n, last: Option<&str>| Since {
        runs: runs(n, "Warning"),
        last_retro: last.map(str::to_owned),
    };
    assert_eq!(
        decide(&since(5, None), day("2026-11-15")),
        Some(Why::Days(14))
    );
    assert_eq!(decide(&since(5, None), day("2026-11-14")), None);
    assert_eq!(
        decide(&since(4, None), day("2026-11-30")),
        None,
        "too few runs"
    );
    let after = since(5, Some("2026-11-10T09-00-00Z"));
    assert_eq!(decide(&after, day("2026-11-23")), None);
    assert_eq!(decide(&after, day("2026-11-24")), Some(Why::Days(14)));
}

fn index(store: &Path, rows: &[serde_json::Value]) {
    std::fs::create_dir_all(store).unwrap();
    let lines: String = rows.iter().map(|r| format!("{r}\n")).collect();
    std::fs::write(store.join("index.jsonl"), lines).unwrap();
}

fn review(ts: &str, project: &str, version: &str) -> serde_json::Value {
    serde_json::json!({"ts": ts, "kind": "workflow", "name": "review", "project": project,
        "branch": "feat/x", "craftVersion": version, "verdict": "Warning"})
}

fn ctx(home: &Path, now: &str, env: &[(&str, &str)]) -> Ctx {
    Ctx {
        env: env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect::<HashMap<_, _>>(),
        home: Some(home.to_path_buf()),
        fallback_cwd: home.to_path_buf(),
        now: iso::parse(now).unwrap(),
    }
}

#[test]
fn the_offer_counts_this_repositorys_runs_of_this_version_since_its_retro_once_a_day() {
    let home = tempfile::tempdir().unwrap();
    let store = home.path().join(".craft").join("runs");
    let mut rows: Vec<serde_json::Value> = (0..20)
        .map(|i| review(&format!("2026-11-01T10-{i:02}-00Z"), KEY, V))
        .collect();
    rows.push(review("2026-11-01T12-00-00Z", "/w/other", V));
    rows.push(review("2026-11-01T12-01-00Z", KEY, "0.8.0"));
    index(&store, &rows);
    let at = ctx(home.path(), "2026-11-02T08:00:00Z", &[]);
    let said = offer(&at, KEY, V).unwrap();
    assert!(
        said.starts_with(
            "craft: 20 review run(s) of craft 0.9.0 in this repository since the first of them."
        ),
        "{said}"
    );
    assert!(said.contains("CRAFT_RETRO_HOOK=0"), "{said}");
    assert_eq!(offer(&at, KEY, V), None, "once a day");
    assert!(
        offer(&ctx(home.path(), "2026-11-03T08:00:00Z", &[]), KEY, V).is_some(),
        "the next day again"
    );
    assert_eq!(
        offer(
            &ctx(home.path(), "2026-11-04T08:00:00Z", &[(SWITCH, "0")]),
            KEY,
            V
        ),
        None
    );
    assert_eq!(
        offer(
            &ctx(home.path(), "2026-11-04T08:00:00Z", &[]),
            "/w/other",
            V
        ),
        None,
        "one run"
    );

    rows.push(serde_json::json!({"ts": "2026-11-01T13-00-00Z", "kind": "retro", "name": "retro", "project": KEY}));
    rows.push(review("2026-11-01T13-30-00Z", KEY, V));
    index(&store, &rows);
    assert_eq!(
        offer(&ctx(home.path(), "2026-11-05T08:00:00Z", &[]), KEY, V),
        None,
        "counted anew from the retro"
    );
}
