//! A lens answer refused only for the CONSUMERS lines it left unmarked is not lost when the lens
//! would end failed — its retries spent, a later answer that could not look, abandoned at its
//! deadline, or a stop between the answer's refusal and the state's save: the lens takes it, the
//! lines reported.
#![expect(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "the helpers of these tests fail loudly, like the tests they serve"
)]

mod common;

use std::path::{Path, PathBuf};

use common::consumers::one_consumer;
use common::{ids, lens, opts, scout, submit, titled, write_answer};
use craft_review::step::{self, Said};
use serde_json::{Value, json};

const ERRORS: &str = "lens-rust-errors-r1";

/// Every task's answer but the errors lens's: each other lens marks the one CONSUMERS line.
fn other(id: &str) -> Value {
    if id.starts_with("scout-") {
        scout("small", &["errors"])
    } else if let Some(rest) = id.strip_prefix("lens-rust-") {
        let mut a = lens(rest.split('-').next().unwrap(), &[]);
        a["consumers"] = json!([{"site": "src/user.rs:2", "status": "checked"}]);
        a
    } else if id.starts_with("dedup-") {
        json!({"groups": []})
    } else {
        common::verdict(false)
    }
}

/// The errors lens's answer refused only for the line it leaves unmarked.
fn marks_only() -> Value {
    lens("errors", &[titled("High", 1, "f returns 2")])
}

/// A run over [`one_consumer`]: its directory, the repository and the run's parent kept alive.
fn started() -> (PathBuf, Value, [tempfile::TempDir; 2]) {
    let repo = tempfile::tempdir().unwrap();
    one_consumer(repo.path());
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let s = step::start(&opts(repo.path(), out.path())).unwrap();
    (run, s, [repo, out])
}

/// Answers every pending task of `s` as [`other`] does, the errors lens by `errors`, to the end.
fn to_end(run: &Path, mut s: Value, mut errors: impl FnMut() -> Value) -> Value {
    while s["done"] == json!(false) {
        let mut answers = serde_json::Map::new();
        for id in ids(&s) {
            let a = if id == ERRORS { errors() } else { other(&id) };
            answers.insert(id, a);
        }
        s = submit(run, Value::Object(answers));
    }
    s
}

/// Where the run keeps the errors lens's marks-only answer.
fn kept(run: &Path) -> PathBuf {
    run.join("answers")
        .join(format!("{ERRORS}.marks-only.json"))
}

fn kept_its_findings(s: &Value) {
    assert!(s["findings"].to_string().contains("f returns 2"), "{s}");
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(!report.contains("lenses that never returned"), "{report}");
}

#[test]
fn an_answer_refused_only_for_marks_is_taken_when_every_retry_fails() {
    let (run, s, _dirs) = started();
    let mut errors_asked = 0;
    let s = to_end(&run, s, || {
        errors_asked += 1;
        if errors_asked == 1 {
            marks_only()
        } else {
            json!({"off": "schema"})
        }
    });
    assert_eq!(errors_asked, 3, "{s}");
    kept_its_findings(&s);
    // Its unmarked line is kept as left by it, though another lens marked it.
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap();
    assert_eq!(
        state["rounds"]["consumersLeft"],
        json!(["src/user.rs:2"]),
        "{state}"
    );
}

#[test]
fn an_answer_refused_only_for_marks_is_taken_when_a_later_one_could_not_look() {
    let (run, s, _dirs) = started();
    let mut errors_asked = 0;
    let s = to_end(&run, s, || {
        errors_asked += 1;
        if errors_asked == 1 {
            marks_only()
        } else {
            let mut a = lens("errors", &[]);
            a["blocked"] = json!({"couldNotLook": true, "what": "sandbox"});
            a
        }
    });
    assert_eq!(errors_asked, 2, "{s}");
    kept_its_findings(&s);
}

#[test]
fn an_answer_refused_only_for_marks_is_taken_when_the_task_is_abandoned() {
    let (run, _, _dirs) = started();
    let s = submit(&run, json!({"scout-rust": other("scout-rust")}));
    let mut answers = serde_json::Map::new();
    for id in ids(&s) {
        let a = if id == ERRORS {
            marks_only()
        } else {
            other(&id)
        };
        answers.insert(id, a);
    }
    let s = submit(&run, Value::Object(answers));
    assert_eq!(ids(&s), [ERRORS], "{s}");
    let abandoned = [ERRORS.to_owned()];
    let said = Said {
        abandoned: &abandoned,
        ..Said::default()
    };
    let s = step::submit_with(&run, None, &said).unwrap();
    let s = to_end(&run, s, || panic!("the abandoned lens is not asked again"));
    kept_its_findings(&s);
}

#[test]
fn an_answer_refused_only_for_marks_survives_a_stop_before_the_state_is_saved() {
    let (run, _, _dirs) = started();
    let s = submit(&run, json!({"scout-rust": other("scout-rust")}));
    for id in ids(&s) {
        let a = if id == ERRORS {
            marks_only()
        } else {
            other(&id)
        };
        write_answer(&s, &id, &a.to_string());
    }
    // The submit sets the refused answer file aside, then the process stops before the state is
    // saved: the state on disk is the one from before.
    let before = std::fs::read(run.join("state.json")).unwrap();
    step::submit(&run, None).unwrap();
    std::fs::write(run.join("state.json"), before).unwrap();
    let mut s = step::submit(&run, None).unwrap();
    while s["done"] == json!(false) && ids(&s) == [ERRORS] {
        s = step::submit(&run, None).unwrap();
    }
    let s = to_end(&run, s, || panic!("the errors lens's retries are spent"));
    kept_its_findings(&s);
}

#[test]
fn the_kept_answer_is_dropped_once_a_later_one_is_accepted() {
    let (run, _, _dirs) = started();
    let s = submit(&run, json!({"scout-rust": other("scout-rust")}));
    let mut answers = serde_json::Map::new();
    for id in ids(&s) {
        let a = if id == ERRORS {
            marks_only()
        } else {
            other(&id)
        };
        answers.insert(id, a);
    }
    let s = submit(&run, Value::Object(answers));
    assert!(kept(&run).exists(), "kept beside the answers");
    let s = to_end(&run, s, || other(ERRORS));
    assert!(!kept(&run).exists(), "dropped once accepted: {s}");
}
