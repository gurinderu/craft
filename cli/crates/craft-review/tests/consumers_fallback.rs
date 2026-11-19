//! A lens answer refused only for the CONSUMERS lines it left unmarked is not lost when every
//! later attempt fails: the lens takes it, the lines reported.

mod common;

use common::consumers::one_consumer;
use common::{ids, lens, opts, scout, submit, titled};
use craft_review::step;
use serde_json::{Value, json};

#[test]
fn an_answer_refused_only_for_marks_is_taken_when_every_retry_fails() {
    let repo = tempfile::tempdir().unwrap();
    one_consumer(repo.path());
    let out = tempfile::tempdir().unwrap();
    let run = out.path().join("run");
    let mut s = step::start(&opts(repo.path(), out.path())).unwrap();
    let mut errors_asked = 0;
    while s["done"] == json!(false) {
        let mut answers = serde_json::Map::new();
        for id in ids(&s) {
            let a = if id.starts_with("scout-") {
                scout("small", &["errors"])
            } else if id == "lens-rust-errors-r1" {
                errors_asked += 1;
                if errors_asked == 1 {
                    lens("errors", &[titled("High", 1, "f returns 2")])
                } else {
                    json!({"off": "schema"})
                }
            } else if let Some(rest) = id.strip_prefix("lens-rust-") {
                let mut a = lens(rest.split('-').next().unwrap(), &[]);
                a["consumers"] = json!([{"site": "src/user.rs:2", "status": "checked"}]);
                a
            } else if id.starts_with("dedup-") {
                json!({"groups": []})
            } else {
                common::verdict(false)
            };
            answers.insert(id, a);
        }
        s = submit(&run, Value::Object(answers));
    }
    assert_eq!(errors_asked, 3, "{s}");
    assert!(s["findings"].to_string().contains("f returns 2"), "{s}");
    let report = std::fs::read_to_string(s["report"].as_str().unwrap()).unwrap();
    assert!(!report.contains("lenses that never returned"), "{report}");
    // Its unmarked line is kept as left by it, though another lens marked it.
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(run.join("state.json")).unwrap()).unwrap();
    assert_eq!(
        state["rounds"]["consumersLeft"],
        json!(["src/user.rs:2"]),
        "{state}"
    );
}
