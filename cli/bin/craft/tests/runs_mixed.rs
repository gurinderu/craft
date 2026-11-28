//! A store holding review runs of both drivers on one branch — the retired JS engine's `review`,
//! the CLI's under its interim name `cli-review` and under `review` with `driver: cli` — read by
//! `craft runs retro` and `round-pairs`: each chain its own population, never merged or paired
//! with the other (`REALITY.md`, the mixed-chains row; this file is a rung, not the carrier).
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};

fn round(n: u64, over: &Value) -> Value {
    let mut r = json!({"schemaVersion": 1, "kind": "workflow", "name": "review", "runtime": "claude-code",
        "craftVersion": "1.0.0", "engineRevision": 4, "project": "/p", "branch": "feat/x", "head": "aaa",
        "round": n, "ts": format!("2026-10-0{n}T00-00-00Z"), "verdict": "Warning",
        "findings": {"total": 3, "bySeverity": {"Medium": 3}}, "filesDigest": "f", "base": "main",
        "verification": {"candidates": 4, "confirmed": 3}, "runtimeStats": {"agents": 10, "wallClockMinutes": 5},
        "dimensions": [{"dimension": "rust:errors", "findingCount": 2, "confirmedCount": 1, "refutedCount": 9, "unverifiedCount": 0}]});
    let fields = r.as_object_mut().unwrap();
    for (k, v) in over.as_object().unwrap() {
        fields.insert(k.clone(), v.clone());
    }
    r
}

fn store() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let said = json!({"count": 1, "findings": [{"fp": "f1", "toPr": false}]});
    let records = [
        round(1, &json!({"memoryContradictions": said})),
        round(
            1,
            &json!({"name": "cli-review", "ts": "2026-10-01T01-00-00Z"}),
        ),
        round(2, &json!({"ledger": [{"fp": "f1", "disposition": "open"}]})),
        round(
            2,
            &json!({"driver": "cli", "ts": "2026-10-03T01-00-00Z", "ledger": [{"fp": "f1", "disposition": "closed"}]}),
        ),
        round(
            1,
            &json!({"branch": "feat/y", "head": "bbb", "depth": "light"}),
        ),
        round(
            1,
            &json!({"partial": true, "partialReason": "died", "branch": "feat/z"}),
        ),
        round(
            1,
            &json!({"driver": "cli", "partial": true, "partialReason": "died", "branch": "feat/z"}),
        ),
    ];
    for (i, r) in records.iter().enumerate() {
        std::fs::write(d.path().join(format!("{i}.json")), r.to_string()).unwrap();
    }
    d
}

fn lines(store: &Path, args: &[&str]) -> Vec<Value> {
    let out = Command::new(env!("CARGO_BIN_EXE_craft"))
        .arg("runs")
        .args(args)
        .args(["--json", "--store"])
        .arg(store)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn section<'a>(ls: &'a [Value], name: &str) -> Vec<&'a Value> {
    ls.iter().filter(|l| l["section"] == name).collect()
}

#[test]
fn each_chain_is_its_own_population_in_the_retro() {
    let d = store();
    let ls = lines(d.path(), &["retro"]);
    let runs: Vec<(String, Value)> = section(&ls, "workflow")
        .iter()
        .map(|w| (w["name"].as_str().unwrap().to_owned(), w["runs"].clone()))
        .collect();
    assert_eq!(
        runs,
        [
            ("cli-review".to_owned(), json!(1)),
            ("review".into(), json!(3)),
            ("review (cli)".into(), json!(1))
        ]
    );
    let depth: Vec<(String, Value, Value)> = section(&ls, "depth")
        .iter()
        .map(|p| {
            (
                format!(
                    "{} {}",
                    p["chain"].as_str().unwrap(),
                    p["depth"].as_str().unwrap()
                ),
                p["runs"].clone(),
                p["agentsPerRun"].clone(),
            )
        })
        .collect();
    assert_eq!(depth[0], ("js light".into(), json!(1), json!(10)));
    assert_eq!(depth[1], ("js full".into(), json!(2), json!(10)));
    assert_eq!(depth[3], ("cli full".into(), json!(2), json!(10)));
    let lenses: Vec<&str> = section(&ls, "lens")
        .iter()
        .map(|l| l["lens"].as_str().unwrap())
        .collect();
    assert_eq!(
        lenses,
        ["rust:errors", "rust:errors (cli)"],
        "one lens key, two rows"
    );
    let refuted: Vec<&Value> = section(&ls, "lens").iter().map(|l| &l["refuted"]).collect();
    assert_eq!(
        refuted,
        [&json!(27), &json!(18)],
        "three JS runs and two CLI runs, never summed together"
    );
    let js = section(&ls, "contradictions")
        .into_iter()
        .find(|c| c["chain"] == "js")
        .unwrap();
    assert_eq!(
        (js["open"].clone(), js["fixed"].clone()),
        (json!(1), json!(0)),
        "its fate is its own chain's later round"
    );
    let chains: Vec<&Value> = section(&ls, "unfinishedRun")
        .iter()
        .map(|u| &u["chain"])
        .collect();
    assert_eq!(chains, [&json!("js"), &json!("cli")]);
    assert_eq!(
        section(&ls, "summary")[0]["folded"],
        json!(0),
        "a JS and a CLI run of one head and round are two runs"
    );
}

#[test]
fn rounds_pair_within_a_chain_never_across() {
    let d = store();
    let ls = lines(d.path(), &["round-pairs"]);
    let pairs = section(&ls, "roundPair");
    assert_eq!(pairs.len(), 2, "{pairs:?}");
    assert!(
        pairs
            .iter()
            .all(|p| p["fromRound"] == json!(1) && p["toRound"] == json!(2))
    );
    assert!(
        pairs.iter().all(|p| p["status"] != "engine-changed"),
        "{pairs:?}"
    );
}
