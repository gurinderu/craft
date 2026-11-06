//! The step protocol end to end over a fixture repository with a real git diff.

mod common;

use std::path::Path;

use common::{answers, finding, fixture, ids, opts, prompt_of, verdict};
use craft_review::status;
use craft_review::step;
use serde_json::{Map, json};

#[test]
fn start_renders_the_lens_over_the_diff() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    assert_eq!(s["done"], json!(false));
    let task = &s["tasks"][0];
    let run = out.path().join("run");
    let at = |p: &str| json!(run.join(p).display().to_string());
    assert_eq!(
        task,
        &json!({
            "id": "lens-intent", "label": "lens:intent", "model": "opus",
            "promptFile": at("tasks/lens-intent.md"),
            "schemaFile": at("tasks/lens-intent.schema.json"),
            "answerFile": at("answers/lens-intent.json"),
        }),
        "the task names its files and carries no prompt or schema text"
    );
    assert!(run.join("answers").is_dir());
    let prompt = prompt_of(task);
    let prompt = prompt.as_str();
    assert!(
        prompt.contains("--merge-base 'origin/main' -- '*.rs'"),
        "{prompt}"
    );
    assert!(
        prompt.contains("feat: add f, which never fails"),
        "the commit log is the spec"
    );
    assert!(prompt.contains("`/craft/skills/review-rules`"));
    assert!(
        !prompt.contains("{{"),
        "an unrendered placeholder: {prompt}"
    );
    let schema: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(run.join("tasks/lens-intent.schema.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        schema["properties"]["findings"]["items"]["type"],
        json!("object"),
        "the schema file is whole, its references inlined"
    );
    assert!(out.path().join("run/state.json").is_file());
    let again = step::start(&opts(repo.path(), out.path())).unwrap_err();
    assert!(again.to_string().contains("holds a run already"), "{again}");
}

#[test]
fn a_full_loop_goes_lens_then_verify_then_done() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = step::start(&opts(repo.path(), out.path())).unwrap()["run"]
        .as_str()
        .unwrap()
        .to_owned();
    let run = Path::new(&run);
    let lens = json!({"lens": "intent", "findings": [finding("High", 1), finding("Medium", 1), finding("Medium", 1), finding("Low", 1)]});
    // An agent's final text carrying JSON is read as that JSON.
    let s = step::submit(
        run,
        Some(&answers(json!({"lens-intent": lens.to_string()}))),
    )
    .unwrap();
    assert_eq!(ids(&s), ["verify-0", "verify-batch-0"]);
    let batch_prompt = prompt_of(&s["tasks"][1]);
    assert!(batch_prompt.contains("--- FINDING 1 ---") && batch_prompt.contains("(0..1)"));
    let s = step::submit(
        run,
        Some(&answers(json!({
            "verify-0": verdict(false),
            "verify-batch-0": {"verdicts": [
                {"index": 0, "refuted": false, "citedLineMatches": true, "reachable": false, "premiseSupported": true, "reason": "test-only"},
                {"index": 1, "refuted": true, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "reason": "no"}
            ]}
        }))),
    )
    .unwrap();
    assert_eq!(s["done"], json!(true));
    assert_eq!(s["verdict"], json!("Block"));
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("**High** `src/lib.rs:1` — bad at 1"),
        "{report}"
    );
    assert!(
        report.contains("**Low** `src/lib.rs:1`"),
        "an unreachable Medium is demoted: {report}"
    );
    assert!(
        report.contains("4 finding(s) reported: 2 confirmed, 0 suspected, 1 refuted, 1 unverified"),
        "the Low went unverified: {report}"
    );
    assert!(
        report.contains("1 Low/Info finding(s) NOT VERIFIED"),
        "{report}"
    );
    let st = status::status(run).unwrap();
    assert_eq!(
        (st["phase"].clone(), st["tiers"]["refuted"].clone()),
        (json!("done"), json!(1))
    );
    let late = step::submit(run, Some(&Map::new())).unwrap_err();
    assert!(late.to_string().contains("is done"), "{late}");
}

#[test]
fn a_run_of_low_and_info_findings_ends_unverified_with_no_verifier() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let lens = json!({"lens": "intent", "findings": [finding("Low", 1), finding("Info", 1)]});
    let s = step::submit(&run, Some(&answers(json!({"lens-intent": lens})))).unwrap();
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("Approve"))
    );
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("2 finding(s) reported: 0 confirmed, 0 suspected, 0 refuted, 2 unverified"),
        "{report}"
    );
    assert!(
        report.contains("2 Low/Info finding(s) NOT VERIFIED"),
        "{report}"
    );
}

#[test]
fn an_invalid_answer_is_asked_again_then_fails_the_task() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = step::submit(
        &run,
        Some(&answers(json!({"lens-intent": {"lens": "intent"}}))),
    )
    .unwrap();
    assert_eq!(ids(&s), ["lens-intent"]);
    let prompt = prompt_of(&s["tasks"][0]);
    assert!(
        prompt.contains("Your previous answer was invalid: it does not match the schema"),
        "{prompt}"
    );
    assert!(
        prompt.contains("findings"),
        "the note names what is missing: {prompt}"
    );
    let s = step::submit(&run, Some(&Map::new())).unwrap();
    assert!(prompt_of(&s["tasks"][0]).contains("no answer was submitted"));
    assert_eq!(
        status::status(&run).unwrap()["tasks"][0]["retries"],
        json!(2)
    );
    let s = step::submit(&run, Some(&answers(json!({"lens-intent": "not json"})))).unwrap();
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("INCOMPLETE"))
    );
}

#[test]
fn a_batch_verdict_missing_an_index_is_asked_again() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let lens = json!({"lens": "intent", "findings": [finding("Medium", 1), finding("Medium", 2)]});
    step::submit(&run, Some(&answers(json!({"lens-intent": lens})))).unwrap();
    let one = json!({"verdicts": [{"index": 0, "refuted": false, "citedLineMatches": true, "reachable": true, "premiseSupported": true, "reason": "r"}]});
    let s = step::submit(&run, Some(&answers(json!({"verify-batch-0": one})))).unwrap();
    assert!(prompt_of(&s["tasks"][0]).contains("no verdict for index 1"));
}

#[test]
fn an_answer_for_no_pending_task_is_refused_and_changes_nothing() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let err = step::submit(&run, Some(&answers(json!({"verify-7": {}})))).unwrap_err();
    assert!(err.to_string().contains("verify-7"));
    assert_eq!(
        status::status(&run).unwrap()["tasks"][0]["retries"],
        json!(0)
    );
}

#[test]
fn a_lens_with_no_findings_and_a_diff_with_no_rust_both_approve() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = step::submit(
        &run,
        Some(&answers(
            json!({"lens-intent": {"lens": "intent", "findings": []}}),
        )),
    )
    .unwrap();
    assert_eq!(s["verdict"], json!("Approve"));

    let repo = fixture(false);
    let out = tempfile::tempdir().unwrap();
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    assert_eq!(
        (s["done"].clone(), s["verdict"].clone()),
        (json!(true), json!("Approve"))
    );
}

#[test]
fn a_base_that_is_no_commit_is_refused() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let mut o = opts(repo.path(), out.path());
    o.base = Some("--output=/tmp/x".into());
    let err = step::start(&o).unwrap_err();
    assert!(err.to_string().contains("is not a commit"), "{err}");
    o.base = Some("nope".into());
    let err = step::start(&o).unwrap_err();
    assert!(err.to_string().contains("is not a commit"), "{err}");
}
