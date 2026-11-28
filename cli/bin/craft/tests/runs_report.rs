//! `craft runs retro` and `hooks` over small stores laid out by hand: `--engine latest` names the
//! newest finished run's engine, the summary counts what it read past, a resumed run stands as its
//! newest record, and a hook log of one harness names none.
#![expect(
    clippy::unwrap_used,
    reason = "the fixture fails the test loudly, like the tests it serves"
)]

use std::path::Path;
use std::process::{Command, Output};

use serde_json::{Value, json};

fn run(ts: &str, over: &Value) -> Value {
    let mut r = json!({"schemaVersion": 1, "kind": "workflow", "name": "review", "runtime": "claude-code",
        "craftVersion": "1.0.0", "engineRevision": 4, "project": "/p", "branch": "b", "ts": ts,
        "verdict": "Approve", "findings": {"total": 0, "bySeverity": {}}});
    let fields = r.as_object_mut().unwrap();
    for (k, v) in over.as_object().unwrap() {
        fields.insert(k.clone(), v.clone());
    }
    r
}

fn store(records: &[Value]) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    for (i, r) in records.iter().enumerate() {
        std::fs::write(d.path().join(format!("{i:02}.json")), r.to_string()).unwrap();
    }
    d
}

fn craft(store: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_craft"))
        .arg("runs")
        .args(args)
        .args(["--json", "--store"])
        .arg(store)
        .output()
        .unwrap()
}

fn line<'a>(out: &'a [Value], section: &str) -> &'a Value {
    out.iter().find(|l| l["section"] == section).unwrap()
}

fn lines(out: &Output) -> Vec<Value> {
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

#[test]
fn the_latest_engine_is_the_newest_finished_runs_and_not_a_develop_cycles() {
    let d = store(&[
        run("2026-01-01T00-00-00Z", &json!({"engineRevision": 3})),
        run("2026-01-02T00-00-00Z", &json!({})),
        run(
            "2026-01-03T00-00-00Z",
            &json!({"engineRevision": 5, "partial": true}),
        ),
        run(
            "2026-01-04T00-00-00Z",
            &json!({"kind": "develop", "craftVersion": null, "engineRevision": 9}),
        ),
        run(
            "2026-01-01T12-00-00Z",
            &json!({"engineRevision": 7, "schemaVersion": null}),
        ),
    ]);
    let out = lines(&craft(d.path(), &["retro", "--engine", "latest"]));
    let summary = line(&out, "summary");
    assert_eq!(summary["engine"], json!("claude-code 1.0.0 r4"));
    assert_eq!(
        (summary["runs"].clone(), summary["legacy"].clone()),
        (json!(1), json!(1))
    );
    let empty = store(&[]);
    let refused = craft(empty.path(), &["retro", "--engine", "latest"]);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("latest engine"));
}

#[test]
fn the_summary_counts_what_the_retro_read_past_and_a_resumed_run_stands_as_its_newest() {
    let same = json!({"head": "h", "filesDigest": "f", "round": 1, "findings": {"total": 1, "bySeverity": {"Low": 1}}});
    let mut newer = same.clone();
    newer["verdict"] = json!("Warning");
    let d = store(&[
        run("2026-01-01T00-00-00Z", &same),
        run("2026-01-01T01-00-00Z", &newer),
        run("2026-01-01T02-00-00Z", &json!({"partial": true})),
        run(
            "2026-01-01T03-00-00Z",
            &json!({"partial": true, "craftVersion": "2.0.0"}),
        ),
        run("2026-01-01T04-00-00Z", &json!({"craftVersion": "2.0.0"})),
        run("2026-01-01T05-00-00Z", &json!({"schemaVersion": 0})),
    ]);
    let out = lines(&craft(d.path(), &["retro", "1.0.0"]));
    let s = line(&out, "summary");
    let got: Vec<Value> = ["runs", "folded", "unfinished", "legacy", "other"]
        .iter()
        .map(|k| s[*k].clone())
        .collect();
    assert_eq!(got, [json!(1), json!(1), json!(1), json!(1), json!(3)]);
    let review = out.iter().find(|l| l["section"] == "workflow").unwrap();
    assert_eq!(
        review["verdicts"]["warning"],
        json!(1),
        "the newest record stands for the run"
    );
}

#[test]
fn a_hook_log_of_one_harness_names_none_and_reads_quietly() {
    let d = store(&[
        run("2026-01-01T00-00-00Z", &json!({})),
        run("2025-12-31T00-00-00Z", &json!({})),
    ]);
    let log = d.path().join("hooks.jsonl");
    let line = |ts: &str, spoke: bool| {
        json!({"ts": ts, "repo": "/p", "spoke": spoke, "silent": null}).to_string()
    };
    std::fs::write(
        &log,
        format!(
            "{}\n\n{}\n",
            line("2025-12-31T12:00:00Z", true),
            line("2026-01-01T00:00:00Z", false)
        ),
    )
    .unwrap();
    let out = craft(d.path(), &["hooks", "--log", log.to_str().unwrap()]);
    assert!(
        out.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let ls = lines(&out);
    let row = ls.iter().find(|l| l["section"] == "hook").unwrap();
    assert_eq!(row["group"], json!("SessionStart"));
    assert_eq!(row["silentBy"], json!({"unknown": 1}));
    let join = ls.iter().find(|l| l["section"] == "hookJoin").unwrap();
    assert_eq!(
        (join["joined"].clone(), join["workflowRuns"].clone()),
        (json!(1), json!(2))
    );
}

#[test]
fn of_records_filed_at_one_time_the_first_read_stands() {
    let d = store(&[
        run("2026-01-01T00-00-00Z", &json!({"engineRevision": 3})),
        run("2026-01-01T00-00-00Z", &json!({"engineRevision": 4})),
    ]);
    let out = lines(&craft(d.path(), &["retro", "--engine", "latest"]));
    assert_eq!(
        line(&out, "summary")["engine"],
        json!("claude-code 1.0.0 r3")
    );
    let same = json!({"head": "h", "filesDigest": "f", "round": 1, "findings": {"total": 1, "bySeverity": {"Low": 1}}});
    let mut warning = same.clone();
    warning["verdict"] = json!("Warning");
    let d = store(&[
        run("2026-01-01T00-00-00Z", &same),
        run("2026-01-01T00-00-00Z", &warning),
    ]);
    let out = lines(&craft(d.path(), &["retro"]));
    let review = out.iter().find(|l| l["section"] == "workflow").unwrap();
    assert_eq!(
        (
            review["verdicts"]["approve"].clone(),
            review["verdicts"]["warning"].clone()
        ),
        (json!(1), json!(0))
    );
}

#[test]
fn a_stopped_part_of_another_version_is_read_past_as_another_versions() {
    let part = json!({"driver": "cli", "cliRun": "/r/1", "verdict": "INCOMPLETE", "craftVersion": "0.9.0"});
    let mut finished = part.clone();
    (finished["verdict"], finished["craftVersion"]) = (json!("Approve"), json!("1.0.0"));
    let d = store(&[
        run("2026-01-01T00-00-00Z", &part),
        run("2026-01-01T01-00-00Z", &finished),
    ]);
    let s = line(&lines(&craft(d.path(), &["retro", "1.0.0"])), "summary").clone();
    let got: Vec<Value> = ["runs", "folded", "other"]
        .iter()
        .map(|k| s[*k].clone())
        .collect();
    assert_eq!(got, [json!(1), json!(0), json!(1)]);
}

#[test]
fn a_retro_mark_is_no_run_no_engine_and_nothing_read_past() {
    let mark = json!({"kind": "retro", "name": "retro", "engineRevision": 9, "verdict": ""});
    let unversioned = json!({"kind": "retro", "name": "retro", "craftVersion": null});
    let d = store(&[
        run("2026-01-01T00-00-00Z", &json!({})),
        run("2026-01-02T00-00-00Z", &mark),
        run("2026-01-03T00-00-00Z", &unversioned),
    ]);
    let out = lines(&craft(d.path(), &["retro", "--engine", "latest"]));
    let s = line(&out, "summary");
    assert_eq!(
        s["engine"],
        json!("claude-code 1.0.0 r4"),
        "the newest mark names no engine"
    );
    let s = line(&lines(&craft(d.path(), &["retro", "1.0.0"])), "summary").clone();
    let got: Vec<Value> = ["runs", "other", "legacy"]
        .iter()
        .map(|k| s[*k].clone())
        .collect();
    assert_eq!(
        got,
        [json!(1), json!(0), json!(0)],
        "a mark is neither another version's run nor a pre-telemetry one"
    );
    let log = d.path().join("hooks.jsonl");
    std::fs::write(
        &log,
        format!(
            "{}\n",
            json!({"ts": "2025-12-31T00:00:00Z", "repo": "/p", "spoke": true})
        ),
    )
    .unwrap();
    let ls = lines(&craft(d.path(), &["hooks", "--log", log.to_str().unwrap()]));
    let join = ls.iter().find(|l| l["section"] == "hookJoin").unwrap();
    assert_eq!(join["workflowRuns"], json!(1));
}
