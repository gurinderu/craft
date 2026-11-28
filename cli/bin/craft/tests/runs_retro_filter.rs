//! `craft runs retro` over the runs the filters of `runs ls` keep — a project's, a branch's, a
//! period's, any version — and its runs by kind (realm @nick/craft, node #658).
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};

fn record(store: &Path, ts: &str, r: &Value) {
    let mut r = r.clone();
    r["ts"] = json!(ts);
    let name = format!("{ts}-workflow-{}.json", r["name"].as_str().unwrap());
    std::fs::write(store.join(&name), r.to_string()).unwrap();
    let row = json!({"ts": ts, "kind": "workflow", "name": r["name"], "craftVersion": r["craftVersion"],
        "project": r["project"], "branch": r["branch"], "head": r["head"], "verdict": r["verdict"]});
    let mut index = std::fs::read_to_string(store.join("index.jsonl")).unwrap_or_default();
    index.push_str(&format!("{row}\n"));
    std::fs::write(store.join("index.jsonl"), index).unwrap();
}

fn review(version: &str, project: &str, branch: &str, scope: &str, minutes: f64) -> Value {
    json!({"schemaVersion": 1, "runtime": "opencode", "craftVersion": version, "kind": "workflow",
        "name": "review", "driver": "cli", "project": project, "branch": branch, "head": "abc",
        "verdict": "Warning", "depth": "light", "lensScope": scope, "findings": {"total": 0},
        "runtimeStats": {"wallClockMinutes": minutes, "agents": 6}})
}

fn retro(store: &Path, args: &[&str]) -> Vec<Value> {
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["runs", "retro", "--json", "--store"])
        .arg(store)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "{out:?}");
    String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn section<'a>(lines: &'a [Value], s: &str) -> Vec<&'a Value> {
    lines.iter().filter(|l| l["section"] == s).collect()
}

#[test]
fn the_filters_keep_a_projects_branch_over_a_period_across_versions_and_name_what_they_kept() {
    let d = tempfile::tempdir().unwrap();
    let s = d.path();
    record(
        s,
        "2026-11-01T10-00-00Z",
        &review("0.60.0", "/w/craft", "feat/a", "delta", 4.0),
    );
    record(
        s,
        "2026-11-02T10-00-00Z",
        &review("0.61.0", "/w/craft", "feat/a", "delta", 2.0),
    );
    record(
        s,
        "2026-11-02T11-00-00Z",
        &review("0.61.0", "/w/craft", "feat/a", "full", 9.0),
    );
    record(
        s,
        "2026-11-02T12-00-00Z",
        &review("0.61.0", "/w/other", "feat/a", "delta", 1.0),
    );
    record(
        s,
        "2026-11-03T10-00-00Z",
        &review("0.61.0", "/w/craft", "feat/b", "delta", 1.0),
    );
    record(
        s,
        "2026-11-09T10-00-00Z",
        &review("0.61.0", "/w/craft", "feat/a", "delta", 1.0),
    );

    let kept = retro(
        s,
        &[
            "--project",
            "craft",
            "--branch",
            "feat/a",
            "--since",
            "2026-11-01",
            "--until",
            "2026-11-05",
        ],
    );
    let summary = section(&kept, "summary")[0];
    assert_eq!(summary["runs"], json!(3), "{kept:?}");
    assert_eq!(summary["version"], Value::Null);
    assert_eq!(
        (
            &summary["project"],
            &summary["branch"],
            &summary["since"],
            &summary["until"]
        ),
        (
            &json!("craft"),
            &json!("feat/a"),
            &json!("2026-11-01"),
            &json!("2026-11-05")
        )
    );
    let kinds = section(&kept, "kind");
    let delta = kinds
        .iter()
        .find(|k| k["kind"] == "review (cli) · light · delta")
        .unwrap();
    assert_eq!(
        (
            &delta["runs"],
            &delta["minutesPerRun"],
            &delta["agentsPerRun"]
        ),
        (&json!(2), &json!(3), &json!(6))
    );
    let full = kinds
        .iter()
        .find(|k| k["kind"] == "review (cli) · light · full")
        .unwrap();
    assert_eq!(full["runs"], json!(1));

    let one = retro(s, &["0.61.0", "--project", "craft"]);
    assert_eq!(section(&one, "summary")[0]["runs"], json!(4));
    assert_eq!(section(&one, "summary")[0]["version"], json!("0.61.0"));
    let flag = retro(s, &["--version", "0.60.0"]);
    assert_eq!(
        section(&flag, "summary")[0]["runs"],
        json!(1),
        "--version names it as the argument does"
    );
}

#[test]
fn a_version_named_twice_is_refused_and_the_text_names_the_filters() {
    let d = tempfile::tempdir().unwrap();
    let s = d.path();
    record(
        s,
        "2026-11-02T10-00-00Z",
        &review("0.61.0", "/w/craft", "feat/a", "delta", 2.0),
    );
    let twice = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["runs", "retro", "0.61.0", "--version", "0.61.0", "--store"])
        .arg(s)
        .output()
        .unwrap();
    assert_eq!(twice.status.code(), Some(2), "{twice:?}");
    let text = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["runs", "retro", "--branch", "feat/a", "--store"])
        .arg(s)
        .output()
        .unwrap();
    let text = String::from_utf8(text.stdout).unwrap();
    assert!(
        text.starts_with("craft, every version · branch feat/a: 1 finished run(s)"),
        "{text}"
    );
    assert!(text.contains("\nKinds\n"), "{text}");
    assert!(text.contains("review (cli) · light · delta"), "{text}");
}

#[test]
fn a_kind_prices_its_usable_costs_and_counts_the_others_in_text_and_json() {
    let d = tempfile::tempdir().unwrap();
    let s = d.path();
    let mut priced = review("0.61.0", "/w/craft", "feat/a", "delta", 4.0);
    priced["cost"] = json!({"total": 1000, "agents": 6, "rule": "per-message"});
    record(s, "2026-11-02T10-00-00Z", &priced);
    let mut partial = review("0.61.0", "/w/craft", "feat/a", "delta", 2.0);
    partial["cost"] = json!({"total": 10, "agents": 6, "rule": "per-message", "skipped": 1});
    record(s, "2026-11-02T11-00-00Z", &partial);
    record(
        s,
        "2026-11-02T12-00-00Z",
        &review("0.61.0", "/w/craft", "feat/a", "delta", 3.0),
    );

    let lines = retro(s, &[]);
    let kind = section(&lines, "kind")[0];
    assert_eq!(
        (&kind["priced"], &kind["cost"], &kind["costPerRun"]),
        (&json!(1), &json!(1000), &json!(1000))
    );
    assert_eq!(kind["unpriced"], json!({"missing": 1, "partial": 1}));
    assert_eq!((&kind["timed"], &kind["counted"]), (&json!(3), &json!(3)));

    let text = Command::new(env!("CARGO_BIN_EXE_craft"))
        .args(["runs", "retro", "--store"])
        .arg(s)
        .output()
        .unwrap();
    let text = String::from_utf8(text.stdout).unwrap();
    let row = text
        .lines()
        .find(|l| l.starts_with("review (cli) · light · delta"))
        .unwrap();
    let cells: Vec<&str> = row
        .split("  ")
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .collect();
    assert_eq!(
        cells,
        [
            "review (cli) · light · delta",
            "3",
            "3",
            "6",
            "1",
            "1000",
            "missing 1, partial 1"
        ],
        "{text}"
    );
}
