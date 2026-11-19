//! A run stopped in the lens rounds still reports the CONSUMERS lines the cut-short round's
//! answers left unmarked, beside the findings it takes from them.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use common::consumers::one_consumer;
use common::{lens, opts, scout, submit, titled, write_answer};
use craft_review::step::{self, Said};
use serde_json::json;

/// Stops a run over [`one_consumer`] on the usage limit once the `errors` lens, never marking its
/// line, has answered; the `intent` lens marks the line first when `intent_marks`.
/// Returns the stopped run's report.
fn stopped(intent_marks: bool) -> String {
    let repo = tempfile::tempdir().unwrap();
    one_consumer(repo.path());
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    step::start(&opts(repo.path(), out.path())).unwrap();
    let s = submit(&run, json!({"scout-rust": scout("small", &["errors"])}));
    if intent_marks {
        let mut a = lens("intent", &[]);
        a["consumers"] = json!([{"site": "src/user.rs:2", "status": "checked"}]);
        write_answer(&s, "lens-rust-intent-r1", &a.to_string());
    }
    let answer = lens("errors", &[titled("High", 1, "kept from the cut round")]).to_string();
    // Taken at once though it leaves its line unmarked, the tests lens still out.
    write_answer(&s, "lens-rust-errors-r1", &answer);
    let limit = Said {
        limit: Some("You've hit your limit"),
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &limit).unwrap();
    assert_eq!(s["stopped"]["cause"], json!("limit"), "{s}");
    let r = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(r.contains("kept from the cut round"), "{r}");
    r
}

#[test]
fn a_stop_mid_round_reports_the_lines_the_round_s_answers_left_unmarked() {
    let r = stopped(false);
    assert!(
        r.contains("- 1 line(s) no lens marked: src/user.rs:2"),
        "{r}"
    );
}

#[test]
fn a_stop_mid_round_does_not_report_a_line_another_answer_of_the_round_marked() {
    let r = stopped(true);
    assert!(!r.contains("no lens marked"), "{r}");
}
