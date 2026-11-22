//! `craft runs` over a store laid out by hand: a broken line passed over and counted on stderr, the
//! filters, NDJSON for jq, the sums of `stats` and `retro`, and what `check` finds.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use std::path::Path;
use std::process::{Command, Output};

use serde_json::{Value, json};

fn record(store: &Path, ts: &str, r: &Value) {
    let mut r = r.clone();
    r["ts"] = json!(ts);
    let name = format!("{ts}-workflow-{}.json", r["name"].as_str().unwrap());
    std::fs::write(store.join(&name), serde_json::to_string_pretty(&r).unwrap()).unwrap();
    let row = json!({"ts": ts, "kind": "workflow", "name": r["name"], "craftVersion": r["craftVersion"],
        "project": r["project"], "branch": r["branch"], "head": r["head"], "verdict": r["verdict"],
        "findingsTotal": r["findings"]["total"], "driver": r.get("driver")});
    let mut index = std::fs::read_to_string(store.join("index.jsonl")).unwrap_or_default();
    index.push_str(&format!("{row}\n"));
    std::fs::write(store.join("index.jsonl"), index).unwrap();
}

fn review(version: &str, verdict: &str, high: u64) -> Value {
    json!({"schemaVersion": 1, "runtime": "claude-code", "craftVersion": version, "kind": "workflow",
        "name": "review", "driver": "cli", "project": "/w/craft", "branch": "feat/x", "head": "abc",
        "verdict": verdict, "findings": {"total": high, "bySeverity": {"Critical": 0, "High": high,
        "Medium": 0, "Low": 0, "Info": 0}}, "notRun": [], "engineRevision": 4,
        "verification": {"candidates": 4, "confirmed": 3, "refuteRate": 0.25},
        "dimensions": [{"dimension": "rust:errors", "ran": true, "findingCount": high,
            "confirmedCount": 3, "refutedCount": 1, "unverifiedCount": 2, "bySeverity": {"High": high}},
            {"dimension": "rust:tests", "ran": false}]})
}

/// A store of two 0.9.0 reviews, one 0.8.0 triage, one INCOMPLETE beside the first review and a
/// broken index line.
fn store() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let mut finished = review("0.9.0", "Block", 2);
    finished["phases"] = json!([{ "phase": "start", "ts": "2026-11-01T09:59:00Z" }]);
    record(d.path(), "2026-11-01T10-00-00Z", &finished);
    let mut dead = review("0.9.0", "INCOMPLETE", 0);
    dead["phases"] = finished["phases"].clone();
    dead["notRun"] = json!(["the craft binary did not finish the run"]);
    record(d.path(), "2026-11-01T10-05-00Z", &dead);
    record(
        d.path(),
        "2026-11-02T10-00-00Z",
        &review("0.9.0", "Approve (PARTIAL COVERAGE)", 0),
    );
    let mut triage = review("0.8.0", "", 0);
    triage["name"] = json!("triage-findings");
    triage["triage"] = json!({"accept": 5, "reject": 2});
    record(d.path(), "2026-10-01T10-00-00Z", &triage);
    let mut index = std::fs::read_to_string(d.path().join("index.jsonl")).unwrap();
    index.push_str("{\"ts\": \"2026-11-03T\n");
    std::fs::write(d.path().join("index.jsonl"), index).unwrap();
    d
}

fn craft(store: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .arg("runs")
        .args(args)
        .arg("--store")
        .arg(store)
        .output()
        .unwrap()
}

fn ndjson(out: &Output) -> Vec<Value> {
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// The address-space ceiling the large-record tests run `craft runs` under: well above what the
/// binary needs to read the store one record at a time (measured on Linux `x86_64`, debug build,
/// 2026-11-21: about 36 MB on an empty store, about 56 MB over these records), so the binary's
/// own size and mappings do not decide the test.
const AS_CEILING: u64 = 128_000_000;
/// The large records: each payload and how many, together 192 MB, half again the ceiling, so a
/// reader that kept them all could not stay under it.
const LARGE_PAYLOAD: usize = 4_000_000;
const LARGE_RECORDS: usize = 48;

#[cfg(target_os = "linux")]
#[test]
fn stats_does_not_keep_large_unfoldable_records_in_memory() {
    if Command::new("prlimit").arg("--version").output().is_err() {
        return;
    }
    let d = tempfile::tempdir().unwrap();
    let mut r = review("0.9.0", "Approve", 0);
    r["payload"] = json!("x".repeat(LARGE_PAYLOAD));
    let bytes = serde_json::to_vec(&r).unwrap();
    for n in 0..LARGE_RECORDS {
        std::fs::write(
            d.path().join(format!("{n:03}-workflow-review.json")),
            &bytes,
        )
        .unwrap();
    }
    let out = Command::new("prlimit")
        .arg(format!("--as={AS_CEILING}"))
        .arg("--")
        .arg(env!("CARGO_BIN_EXE_craft"))
        .args(["runs", "stats", "--json", "--store"])
        .arg(d.path())
        .env("TOKIO_WORKER_THREADS", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(ndjson(&out)[0]["tally"]["runs"], json!(LARGE_RECORDS));
}

#[cfg(target_os = "linux")]
#[test]
fn retro_does_not_keep_large_unfoldable_records_in_memory() {
    if Command::new("prlimit").arg("--version").output().is_err() {
        return;
    }
    let d = tempfile::tempdir().unwrap();
    let mut r = review("0.9.0", "Approve", 0);
    r["payload"] = json!("x".repeat(LARGE_PAYLOAD));
    let bytes = serde_json::to_vec(&r).unwrap();
    for n in 0..LARGE_RECORDS {
        std::fs::write(
            d.path().join(format!("{n:03}-workflow-review.json")),
            &bytes,
        )
        .unwrap();
    }
    let out = Command::new("prlimit")
        .arg(format!("--as={AS_CEILING}"))
        .arg("--")
        .arg(env!("CARGO_BIN_EXE_craft"))
        .args(["runs", "retro", "0.9.0", "--json", "--store"])
        .arg(d.path())
        .env("TOKIO_WORKER_THREADS", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn ls_filters_the_index_says_what_it_passed_over_and_prints_ndjson() {
    let d = store();
    let out = craft(
        d.path(),
        &["ls", "--version", "0.9.0", "--verdict", "block", "--json"],
    );
    assert!(out.status.success());
    let rows = ndjson(&out);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["ts"], json!("2026-11-01T10-00-00Z"));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("passed over 1 index line(s)"), "{err}");
    let table = craft(d.path(), &["ls", "--since", "2026-11-02"]);
    let text = String::from_utf8_lossy(&table.stdout);
    assert_eq!(text.lines().count(), 2, "a header and one run: {text}");
    assert!(text.contains("review (cli)"), "{text}");
}

#[test]
fn show_names_a_record_by_a_unique_prefix_of_its_time() {
    let d = store();
    let out = craft(d.path(), &["show", "2026-11-02", "--json"]);
    assert!(out.status.success());
    assert_eq!(
        ndjson(&out)[0]["verdict"],
        json!("Approve (PARTIAL COVERAGE)")
    );
    let many = craft(d.path(), &["show", "2026-11-01"]);
    assert!(!many.status.success());
    assert!(String::from_utf8_lossy(&many.stderr).contains("names 2 records"));
}

#[test]
fn check_refuses_an_unreadable_checkpoint_directory() {
    for name in [".partial", "cli"] {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(name), "not a directory").unwrap();
        let out = craft(d.path(), &["check"]);
        assert!(!out.status.success(), "{name}");
        assert!(!String::from_utf8_lossy(&out.stdout).contains("clean"));
    }
}

#[test]
fn stats_sum_verdicts_findings_the_verified_share_and_triage_per_group() {
    let d = store();
    let rows = ndjson(&craft(d.path(), &["stats", "--by", "version", "--json"]));
    let (old, new) = (&rows[0]["tally"], &rows[1]["tally"]);
    assert_eq!(rows[1]["group"], json!("0.9.0"));
    assert_eq!(new["runs"], json!(3));
    assert_eq!(
        new["verdicts"],
        json!({"block": 1, "warning": 0, "approve": 0, "incomplete": 2, "partialCoverage": 2})
    );
    assert_eq!(new["findings"]["High"], json!(2));
    assert_eq!(
        new["verified"],
        json!({"candidates": 12, "confirmed": 9, "share": 0.75})
    );
    assert_eq!(old["triage"]["accept"], json!(5));
    assert_eq!(old["triage"]["reject"], json!(2));
}

#[test]
fn a_retro_sums_one_versions_finished_runs_per_workflow_and_lens() {
    let d = store();
    let lines = ndjson(&craft(d.path(), &["retro", "0.9.0", "--json"]));
    let section = |s: &str| {
        lines
            .iter()
            .filter(|l| l["section"] == s)
            .collect::<Vec<_>>()
    };
    assert_eq!(section("summary")[0]["runs"], json!(3));
    assert_eq!(section("summary")[0]["partialCoverage"], json!(2));
    assert_eq!(section("workflow")[0]["name"], json!("review (cli)"));
    assert_eq!(section("workflow")[0]["avgRefute"], json!(0.25));
    assert_eq!(section("notRun")[0]["runs"], json!(1));
    assert!(
        section("lensRound").is_empty(),
        "records with no round yield print none"
    );
    let lenses = section("lens");
    assert_eq!(lenses[0]["lens"], json!("rust:errors (cli)"));
    assert_eq!(
        (
            lenses[0]["runs"].clone(),
            lenses[0]["findings"].clone(),
            lenses[0]["refuteRate"].clone()
        ),
        (json!(3), json!(2), json!(0.25))
    );
    assert_eq!(lenses[1]["dead"], json!(3));
    assert_eq!(
        section("engine")[0]["engine"],
        json!("claude-code+cli 0.9.0 r4")
    );
}

#[test]
fn check_finds_the_broken_line_the_phantom_incomplete_and_exits_one() {
    let d = store();
    std::fs::write(
        d.path().join("2026-12-01T00-00-00Z-workflow-review.json"),
        "{}",
    )
    .unwrap();
    let out = craft(d.path(), &["check", "--json"]);
    assert_eq!(out.status.code(), Some(1));
    let kinds: Vec<Value> = ndjson(&out).iter().map(|l| l["kind"].clone()).collect();
    assert_eq!(
        kinds,
        [
            json!("unreadable-line"),
            json!("unindexed-record"),
            json!("phantom-incomplete")
        ]
    );
    let clean = tempfile::tempdir().unwrap();
    let ok = craft(clean.path(), &["check"]);
    assert!(ok.status.success());
    assert_eq!(
        String::from_utf8_lossy(&ok.stdout).trim(),
        "the store is clean"
    );
}

#[test]
fn check_rejects_a_corrupt_indexed_record() {
    let d = tempfile::tempdir().unwrap();
    record(
        d.path(),
        "2026-11-01T10-00-00Z",
        &review("0.9.0", "Block", 1),
    );
    std::fs::write(
        d.path().join("2026-11-01T10-00-00Z-workflow-review.json"),
        "{",
    )
    .unwrap();
    let out = craft(d.path(), &["check", "--json"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        ndjson(&out)
            .iter()
            .any(|r| r["kind"] == "unreadable-record")
    );
}

#[test]
fn check_reports_unfinalized_checkpoints_with_a_failure_exit() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join(".partial/leftover")).unwrap();
    let out = craft(d.path(), &["check", "--json"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(
        ndjson(&out)
            .iter()
            .any(|r| r["kind"] == "unfinalized-checkpoints")
    );
}

#[test]
fn stats_count_a_resumed_run_once() {
    let d = tempfile::tempdir().unwrap();
    let mut r = review("0.9.0", "Block", 2);
    r["filesDigest"] = json!("same-files");
    r["round"] = json!(2);
    record(d.path(), "2026-11-01T10-00-00Z", &r);
    record(d.path(), "2026-11-01T10-01-00Z", &r);
    let rows = ndjson(&craft(d.path(), &["stats", "--by", "version", "--json"]));
    assert_eq!(rows[0]["tally"]["runs"], json!(1));
}

#[test]
fn check_does_not_call_independent_runs_phantom_twins() {
    let d = tempfile::tempdir().unwrap();
    record(
        d.path(),
        "2026-11-01T10-00-00Z",
        &review("0.9.0", "Block", 2),
    );
    record(
        d.path(),
        "2026-11-01T10-05-00Z",
        &review("0.9.0", "INCOMPLETE", 0),
    );
    let out = craft(d.path(), &["check", "--json"]);
    assert!(
        !ndjson(&out)
            .iter()
            .any(|r| r["kind"] == "phantom-incomplete")
    );
}
