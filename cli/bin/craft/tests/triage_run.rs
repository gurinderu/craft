//! Native triage through the real binary and controlled, read-only host CLIs (#616).
#[cfg(target_os = "linux")]
#[path = "../../../test-support/blocked.rs"]
mod blocked;
#[path = "triage_run/boundaries.rs"]
mod boundaries;
mod common;
#[path = "triage_run/delegate.rs"]
mod delegate;
#[path = "triage_run/fixture.rs"]
mod fixture;
#[cfg(target_os = "linux")]
#[path = "triage_run/interrupt.rs"]
mod interrupt;
#[path = "triage_run/nonempty.rs"]
mod nonempty;

use fixture::{Bench, read};
use serde_json::json;

#[test]
fn native_triage_keeps_its_event_and_record_shape_without_review_statistics() {
    let b = Bench::new();
    let out = b.start("codex", "ok");
    b.expect(&out, 0);
    let event = b.result(&out);
    assert_eq!(event["type"], "triage_result");
    assert_eq!(event["plan_file"], json!(b.path("run/plan.json")));
    assert_eq!(event["summary"], "SUM");
    assert!(event.get("verdict").is_none());
    assert!(event.get("report").is_none());
    assert!(String::from_utf8_lossy(&out.stdout).contains("The plan is "));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("## Verdict"));
    let rec = read(&b.path("run/record.json"));
    assert_eq!(rec["runtime"], "codex");
    assert_eq!(rec["name"], "triage-findings");
    assert_eq!(rec["triage"]["gathered"], 0);
    assert_eq!(
        rec.as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        [
            "schemaVersion",
            "craftVersion",
            "runtime",
            "kind",
            "name",
            "verdict",
            "findings",
            "nested",
            "via",
            "sources",
            "notRun",
            "triage",
            "memory"
        ]
        .map(str::to_owned)
        .into_iter()
        .collect()
    );
}

#[test]
fn report_finishes_in_the_requested_repo_and_repeat_resume_keeps_one_record() {
    let b = Bench::new();
    b.expect(&b.start("codex", "ok"), 0);
    let before = std::fs::read(b.path("run/record.json")).unwrap();
    for _ in 0..2 {
        b.expect(&b.resume("pi", "ok"), 0);
        assert_eq!(std::fs::read(b.path("run/record.json")).unwrap(), before);
        assert_eq!(b.index().len(), 1);
    }
    let calls = b.calls();
    assert_eq!(calls.len(), 2, "a filed resume runs no agent: {calls:?}");
    assert!(calls.iter().all(|c| c["cwd"] == json!(b.path("repo"))));
    assert!(
        calls
            .iter()
            .all(|c| c["args"].as_array().unwrap().contains(&json!("read-only")))
    );
}

#[test]
fn usage_limit_stops_then_resumes_without_changing_the_recorded_host() {
    let b = Bench::new();
    let stopped = b.start("codex", "limit");
    b.expect(&stopped, 1);
    assert!(String::from_utf8_lossy(&stopped.stdout).contains("usage limit"));
    assert!(!b.path("run/plan.json").exists());
    assert!(b.index().is_empty());
    let out = b.resume("pi", "ok");
    b.expect(&out, 0);
    assert_eq!(read(&b.path("run/record.json"))["runtime"], "codex");
    assert_eq!(b.index().len(), 1);
    assert!(b.calls().iter().all(|c| c["cwd"] == json!(b.path("repo"))));
}

#[test]
fn absent_or_malformed_answers_and_a_failed_plan_never_succeed() {
    for mode in ["missing", "malformed", "plan-fails"] {
        let b = Bench::new();
        let out = b.start("codex", mode);
        b.expect(&out, 1);
        let plan = read(&b.path("run/plan.json"));
        if mode == "plan-fails" {
            assert!(plan.as_str().unwrap().contains("Triage failed"));
        } else {
            assert!(!plan["notRun"].as_array().unwrap().is_empty());
        }
        assert_eq!(b.index().len(), 1, "no fallback review record");
        assert_eq!(
            read(&b.path("run/record.json"))["runtime"],
            "codex",
            "{mode}"
        );
    }
}

#[test]
fn new_sources_on_resume_are_refused_before_even_host_preflight() {
    for flag in [
        "--report",
        "--pr",
        "--base",
        "--pr-base",
        "--prior-ledger",
        "--prior-decisions",
    ] {
        let b = Bench::new();
        let out = b
            .command("opencode", "ok")
            .arg("--run")
            .arg(b.path("absent-run"))
            .args([flag, "new"])
            .output()
            .unwrap();
        b.expect(&out, 2);
        assert!(String::from_utf8_lossy(&out.stderr).contains(flag));
        assert!(b.calls().is_empty(), "{flag} must precede preflight");
    }
}

#[test]
fn completed_unfiled_resume_retries_filing_without_rewriting_the_record() {
    let b = Bench::new();
    std::fs::create_dir_all(b.path("home/.craft")).unwrap();
    std::fs::write(b.path("home/.craft/runs"), "blocked").unwrap();
    let out = b.start("codex", "ok");
    b.expect(&out, 0);
    assert_eq!(read(&b.path("run/filing.json"))["record"], "failed");
    let before = std::fs::read(b.path("run/record.json")).unwrap();
    std::fs::remove_file(b.path("home/.craft/runs")).unwrap();
    for _ in 0..2 {
        b.expect(&b.resume("codex", "ok"), 0);
        assert_eq!(std::fs::read(b.path("run/record.json")).unwrap(), before);
        assert_eq!(b.index().len(), 1);
    }
    assert_eq!(b.calls().len(), 2);
}
