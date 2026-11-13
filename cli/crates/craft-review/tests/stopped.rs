//! What the report of a run stopped on the usage limit holds: before verification began, the
//! findings so far unverified; after a resume, the run settled as if it had never stopped.
#![expect(
    clippy::unwrap_used,
    reason = "the helpers are steps of the test, failing loudly like it"
)]

mod common;

use common::{ids, lens, small_run, submit, titled, verdict, write_answer};
use craft_review::step::{self, Said};
use serde_json::{Map, Value, json};

fn report(s: &Value) -> String {
    std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap()
}

fn limit() -> Said<'static> {
    Said {
        limit: Some("You've hit your limit"),
        ..Said::default()
    }
}

#[test]
fn a_stop_in_the_lens_rounds_reports_the_pool_unverified() {
    let repo = common::fixture(true);
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&common::opts(repo.path(), out.path())).unwrap();
    // A large plan: two lens rounds; the first finds one High, the limit hits in the second.
    let s = submit(
        &run,
        json!({"scout-rust": common::scout("large", &["errors"])}),
    );
    let first: Map<String, Value> = ids(&s)
        .into_iter()
        .map(|id| {
            let mine = id.starts_with("lens-rust-errors-");
            let found = [titled("High", 1, "found early")];
            (id, lens("x", if mine { &found } else { &[] }))
        })
        .collect();
    let s = submit(&run, Value::Object(first));
    assert!(ids(&s).iter().all(|id| id.ends_with("-r2")), "{s}");
    let s = step::submit_with(&run, None, &limit()).unwrap();
    assert_eq!(s["stopped"]["cause"], json!("limit"), "{s}");
    let r = report(&s);
    let (_, unverified) = r.split_once("## Unverified findings").expect(&r);
    assert!(unverified.contains("found early"), "{r}");
    assert!(
        r.contains("the lens rounds stopped before verification began"),
        "{r}"
    );
    assert!(
        !r.contains("verification stopped before it finished"),
        "{r}"
    );
}

#[test]
fn a_stop_mid_round_reports_the_answers_that_round_already_holds() {
    let repo = common::fixture(true);
    let out = tempfile::tempdir().unwrap();
    // A small plan: one lens round; one lens answers with a High, the limit hits before the rest.
    let (run, s) = small_run(repo.path(), out.path());
    let found = lens("errors", &[titled("High", 1, "found mid-round")]);
    write_answer(&s, "lens-rust-errors-r1", &found.to_string());
    let s = step::submit_with(&run, None, &limit()).unwrap();
    assert_eq!(s["stopped"]["cause"], json!("limit"), "{s}");
    let r = report(&s);
    assert!(r.contains("INCOMPLETE"), "{r}");
    let (_, unverified) = r.split_once("## Unverified findings").expect(&r);
    assert!(unverified.contains("found mid-round"), "{r}");
    assert!(
        r.contains("the lens rounds stopped before verification began: 1 finding(s)"),
        "{r}"
    );
}

#[test]
fn a_resume_after_a_stop_in_verification_settles_as_usual() {
    let repo = common::fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    let found = lens("errors", &[titled("High", 1, "decided")]);
    write_answer(&s, "lens-rust-errors-r1", &found.to_string());
    write_answer(&s, "lens-rust-intent-r1", &lens("intent", &[]).to_string());
    write_answer(&s, "lens-rust-tests-r1", &lens("tests", &[]).to_string());
    let s = step::submit(&run, None).unwrap();
    assert_eq!(ids(&s), ["verify-0-v0", "verify-0-v1"], "{s}");
    write_answer(&s, "verify-0-v0", &verdict(false).to_string());
    let stopped = step::submit_with(&run, None, &limit()).unwrap();
    assert!(report(&stopped).contains("verification stopped before it finished"));

    let resume = Said {
        resume: true,
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &resume).unwrap();
    assert_eq!(ids(&s), ["verify-0-v1"], "{s}");
    let s = submit(&run, json!({"verify-0-v1": verdict(false)}));
    assert_eq!(s["verdict"], json!("Block"), "{s}");
    let r = report(&s);
    assert!(
        !r.contains("verification stopped before it finished"),
        "{r}"
    );
    assert!(!r.contains("stopped: usage limit"), "{r}");
    assert_eq!(r.matches("decided").count(), 1, "{r}");
}
