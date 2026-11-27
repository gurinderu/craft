use super::fixture::{Bench, read};
use serde_json::json;

#[expect(
    clippy::unwrap_used,
    reason = "fixture command failure fails the owning test"
)]
fn run_nonempty(backend: &str, source: &str) {
    let b = Bench::new();
    let mut cmd = b.command(backend, "nonempty");
    cmd.arg("--run-dir")
        .arg(b.path("run"))
        .arg("--repo")
        .arg(b.path("repo"));
    if source == "pr" {
        cmd.args(["--pr", "17", "--pr-base", "main", "--base", "head"]);
    } else {
        cmd.arg("--report").arg(b.path("report.md"));
    }
    let out = cmd.output().unwrap();
    b.expect(&out, 0);
    assert!(String::from_utf8_lossy(&out.stdout).contains("pinned"));
    check_nonempty(&b, backend, source);
}

#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "fixture observations fail the owning test"
)]
fn check_nonempty(b: &Bench, backend: &str, source: &str) {
    let state = read(&b.path("run/state.json"));
    let tasks = state["tasks"].as_array().unwrap();
    assert_eq!(
        tasks
            .iter()
            .map(|t| t["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            if source == "pr" {
                "gatherPr"
            } else {
                "gatherReport"
            },
            "recall",
            "validate",
            "plan"
        ]
    );
    assert!(tasks.iter().all(|t| t["state"] == "answered"));
    let plan = read(&b.path("run/plan.json"));
    assert!(!plan["memoryDegraded"].as_array().unwrap().is_empty());
    assert!(plan["memory"].as_str().unwrap().contains("pinned"));
    let record = read(&b.path("run/record.json"));
    assert_eq!(record["runtime"], backend);
    assert_eq!(record["triage"]["gathered"], 1);
    assert_eq!(record["triage"]["validated"], 1);
    assert_eq!(b.index().len(), 1);
    check_disposition(&plan, &record, source);
    assert!(b.calls().iter().all(|c| c["cwd"] == json!(b.path("repo"))));
}

#[expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "fixture assertions fail the owning test"
)]
fn check_disposition(plan: &serde_json::Value, record: &serde_json::Value, source: &str) {
    if source == "pr" {
        assert_eq!(plan["issues"].as_array().unwrap().len(), 1);
        assert_eq!(record["triage"]["issues"], 1);
        assert_eq!(
            plan["ledger"][0]["stable_id"],
            "github-pr::src/a.rs:1::test finding"
        );
        assert_eq!(plan["ledger"][0]["action"], "issue");
    } else {
        assert_eq!(record["triage"]["accept"], 1);
    }
}

#[test]
fn nonempty_report_and_pr_reach_recall_validate_plan_with_pinned_memory_unavailable() {
    for backend in ["codex", "pi", "opencode"] {
        for source in ["report", "pr"] {
            run_nonempty(backend, source);
        }
    }
}

#[test]
fn an_unjudged_finding_is_incomplete_even_with_a_valid_plan() {
    let b = Bench::new();
    let out = b.start("codex", "unjudged");
    b.expect(&out, 1);
    let record = read(&b.path("run/record.json"));
    assert_eq!(record["notRun"], json!(["findings-unjudged"]));
    assert_eq!(record["triage"]["needs-decision"], 1);
    assert!(String::from_utf8_lossy(&out.stdout).contains("INCOMPLETE"));
}
