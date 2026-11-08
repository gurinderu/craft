//! A run stopped on the account's usage limit: a whole lens round dead after its retries, or the
//! limit's text the host saw, ends the step INCOMPLETE with the stop and how to resume; the next
//! submit hands the held tasks out again. A lone dead agent — a transient 429 — does not stop it.
mod common;

use common::{fixture, ids, lens, prompt_of, small_run, submit, titled, write_answer};
use craft_review::status;
use craft_review::step::{self, Said};
use serde_json::json;

const LENSES: [&str; 3] = [
    "lens-rust-errors-r1",
    "lens-rust-intent-r1",
    "lens-rust-tests-r1",
];

#[test]
fn a_whole_round_dead_stops_the_run_with_the_limit_note_and_a_submit_resumes_it() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    let mut s = submit(&run, json!({}));
    for _ in 0..2 {
        assert_eq!(ids(&s), LENSES, "asked again on its retries");
        s = step::submit(&run, None).unwrap();
    }
    assert_eq!(
        (&s["done"], &s["verdict"]),
        (&json!(true), &json!("INCOMPLETE"))
    );
    let line = s["line"].as_str().unwrap();
    let resume = format!("craft review submit --run '{}'", run.display());
    for want in [
        "INCOMPLETE — stopped: every agent dispatched in lens round 1 died with no answer, most likely the account's usage limit or an outage. Resume once agents answer again: `",
        resume.as_str(),
    ] {
        assert!(line.contains(want), "{want}: {line}");
    }
    assert_eq!(s["stopped"]["cause"], json!("deaths"));
    assert_eq!(s["resume"], json!(resume));
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(
        report.contains("- stopped: every agent dispatched in lens round 1"),
        "{report}"
    );
    assert_eq!(status::status(&run).unwrap()["done"], json!(false));

    let s = step::submit(&run, None).unwrap();
    assert_eq!(ids(&s), LENSES, "resumed: the round handed out again");
    assert!(!prompt_of(&s["tasks"][0]).contains("previous answer was invalid"));
    for id in LENSES {
        let name = id.split('-').nth(2).unwrap();
        write_answer(&s, id, &lens(name, &[]).to_string());
    }
    let s = step::submit(&run, None).unwrap();
    assert_eq!(
        (&s["done"], &s["verdict"]),
        (&json!(true), &json!("Approve")),
        "{s}"
    );
}

#[test]
fn limit_text_stops_at_once_keeping_the_answers_that_came_in() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    write_answer(&s, "lens-rust-errors-r1", &lens("errors", &[]).to_string());
    let said = Said {
        limit: Some("You've hit your limit · resets 3am\n(Europe/Berlin)"),
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &said).unwrap();
    assert_eq!(
        (&s["done"], &s["verdict"]),
        (&json!(true), &json!("INCOMPLETE"))
    );
    let line = s["line"].as_str().unwrap();
    assert!(
        line.contains("stopped: usage limit reached (You've hit your limit · resets 3am (Europe/Berlin)). Resume once the limit resets: `craft review submit --run"),
        "{line}"
    );
    assert_eq!(s["stopped"]["cause"], json!("limit"));
    let again = step::submit_with(&run, None, &said).unwrap();
    assert_eq!(
        again["stopped"], s["stopped"],
        "a stopped run stays stopped on the limit"
    );

    let s = step::submit(&run, None).unwrap();
    assert_eq!(
        ids(&s),
        ["lens-rust-intent-r1", "lens-rust-tests-r1"],
        "the answer that came in is kept"
    );
    let st = status::status(&run).unwrap();
    assert_eq!(
        st["tasks"][1]["retries"],
        json!(0),
        "the held tasks were not counted"
    );
}

#[test]
fn a_transient_429_does_not_stop_the_run() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    // Rate-limited and dead with no answer, while the rest of its round answered.
    let s = submit(
        &run,
        json!({"lens-rust-intent-r1": lens("intent", &[]), "lens-rust-tests-r1": lens("tests", &[])}),
    );
    assert_eq!(s["done"], json!(false), "{s}");
    assert_eq!(ids(&s), ["lens-rust-errors-r1"], "asked again");
    submit(&run, json!({}));
    let s = submit(&run, json!({}));
    assert_eq!(
        (&s["done"], &s["verdict"]),
        (&json!(true), &json!("INCOMPLETE"))
    );
    assert!(
        s.get("stopped").is_none(),
        "an ordinary death, not a stop: {s}"
    );
}

#[test]
fn a_resume_holds_the_answers_still_missing_rather_than_failing_them() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    // Two rounds dead: every lens at its last retry. Then the host lost its `--limit` submit.
    submit(&run, json!({}));
    submit(&run, json!({}));
    let st = status::status(&run).unwrap();
    assert_eq!(st["tasks"][0]["retries"], json!(2));
    write_answer(&s, "lens-rust-errors-r1", &lens("errors", &[]).to_string());
    let said = Said {
        resume: true,
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &said).unwrap();
    assert!(s.get("stopped").is_none(), "no dead round read: {s}");
    assert_eq!(
        ids(&s),
        ["lens-rust-intent-r1", "lens-rust-tests-r1"],
        "the answer that came in is kept, the missing ones handed out again"
    );
    assert!(!prompt_of(&s["tasks"][0]).contains("previous answer was invalid"));
    let st = status::status(&run).unwrap();
    assert_eq!(
        st["tasks"][1]["retries"],
        json!(0),
        "handed out again with its retries whole"
    );
    assert_eq!(
        s["repo"],
        json!(repo.path().canonicalize().unwrap().display().to_string())
    );
    for id in ["lens-rust-intent-r1", "lens-rust-tests-r1"] {
        let name = id.split('-').nth(2).unwrap();
        write_answer(&s, id, &lens(name, &[]).to_string());
    }
    let s = step::submit_with(&run, None, &said).unwrap();
    assert_eq!(
        (&s["done"], &s["verdict"]),
        (&json!(true), &json!("Approve")),
        "{s}"
    );
}

#[test]
fn a_task_abandoned_at_its_deadline_fails_at_once_and_its_late_answer_is_not_read() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    write_answer(&s, "lens-rust-intent-r1", &lens("intent", &[]).to_string());
    write_answer(&s, "lens-rust-tests-r1", &lens("tests", &[]).to_string());
    // The abandoned agent answers after all, once the host stopped waiting.
    let late = lens(
        "errors",
        &[
            json!({"severity": "High", "title": "late", "file": "src/lib.rs", "line": 1, "why": "w", "fix": "f"}),
        ],
    );
    write_answer(&s, "lens-rust-errors-r1", &late.to_string());
    let abandoned = ["lens-rust-errors-r1".to_owned()];
    let said = Said {
        abandoned: &abandoned,
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &said).unwrap();
    assert_eq!(
        (&s["done"], &s["verdict"]),
        (&json!(true), &json!("INCOMPLETE")),
        "not handed out again: the run ends without it — {s}"
    );
    let not_run = s["notRun"].to_string();
    assert!(
        not_run.contains("errors: abandoned at its deadline"),
        "{not_run}"
    );
    assert_eq!(s["findings"], json!([]), "the late answer is never read");
}

#[test]
fn a_round_of_abandoned_tasks_is_no_limit_stop_the_run_goes_on_without_them() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    let found = lens("errors", &[titled("Medium", 1, "no doc")]);
    write_answer(&s, "lens-rust-errors-r1", &found.to_string());
    write_answer(&s, "lens-rust-intent-r1", &lens("intent", &[]).to_string());
    write_answer(&s, "lens-rust-tests-r1", &lens("tests", &[]).to_string());
    let s = step::submit(&run, None).unwrap();
    let verifiers = ids(&s);
    assert_eq!(verifiers.len(), 1, "a lone verifier: {s}");
    let said = Said {
        abandoned: &verifiers,
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &said).unwrap();
    assert!(
        s.get("stopped").is_none(),
        "a deadline is not the limit: {s}"
    );
    assert_eq!(
        (&s["done"], &s["verdict"]),
        (&json!(true), &json!("INCOMPLETE"))
    );
    let line = s["line"].as_str().unwrap();
    assert!(!line.contains("usage limit"), "{line}");
}

#[test]
fn a_resume_after_a_limit_stop_does_not_hand_an_abandoned_task_out_again() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, s) = small_run(repo.path(), out.path());
    write_answer(&s, "lens-rust-intent-r1", &lens("intent", &[]).to_string());
    let abandoned = ["lens-rust-errors-r1".to_owned()];
    let stopped = Said {
        abandoned: &abandoned,
        limit: Some("You've hit your limit"),
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &stopped).unwrap();
    assert_eq!(s["stopped"]["cause"], json!("limit"));
    // The abandoned agent writes after the stop; the resume hands out only the task held.
    let late = run.join("answers/lens-rust-errors-r1.json");
    std::fs::write(
        &late,
        lens("errors", &[titled("High", 1, "late")]).to_string(),
    )
    .unwrap();
    let resume = Said {
        resume: true,
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &resume).unwrap();
    assert_eq!(ids(&s), ["lens-rust-tests-r1"], "{s}");
    write_answer(&s, "lens-rust-tests-r1", &lens("tests", &[]).to_string());
    let s = step::submit(&run, None).unwrap();
    assert_eq!(s["done"], json!(true));
    assert_eq!(s["findings"], json!([]), "the late answer is never read");
    assert!(
        s["notRun"]
            .to_string()
            .contains("errors: abandoned at its deadline")
    );
}

#[test]
fn a_round_with_one_abandoned_task_and_the_rest_dead_is_no_limit_stop() {
    let repo = fixture(true);
    let out = tempfile::tempdir().unwrap();
    let (run, _) = small_run(repo.path(), out.path());
    let abandoned = ["lens-rust-errors-r1".to_owned()];
    let said = Said {
        abandoned: &abandoned,
        ..Said::default()
    };
    // The errors lens abandoned at its deadline; intent and tests die through their retries.
    let mut s = step::submit_with(&run, None, &said).unwrap();
    for _ in 0..2 {
        assert_eq!(ids(&s), ["lens-rust-intent-r1", "lens-rust-tests-r1"]);
        s = step::submit(&run, None).unwrap();
    }
    assert!(
        s.get("stopped").is_none(),
        "a deadline fire is a live agent that took too long: {s}"
    );
    assert_eq!(
        (&s["done"], &s["verdict"]),
        (&json!(true), &json!("INCOMPLETE"))
    );
    assert!(!s["line"].as_str().unwrap().contains("usage limit"));
}
